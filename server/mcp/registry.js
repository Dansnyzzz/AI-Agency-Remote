import { getStore } from '../store/index.js';
import { encryptSecret, decryptSecret } from '../crypto.js';
import { connectMcp } from './client.js';

/**
 * The MCP servers an account has plugged in.
 *
 * Tool names are prefixed `mcp__<server>__<tool>` — the same shape Claude Code
 * uses, and prefixed for two reasons that both matter. It keeps a server called
 * `filesystem` from shadowing this app's own `read_file`, which would be a silent
 * and very confusing substitution. And it makes the origin of a tool visible in
 * the approval prompt, so somebody being asked to allow something can see it came
 * from outside.
 *
 * **Connections are cached per account and reused.** A stdio server is a child
 * process; starting one per tool call would mean a process launch and a handshake
 * before every call, and for `npx`-based servers that is seconds each time.
 *
 * **Nothing here is driven by the model.** The command to run is typed by the
 * user. A model that could add an MCP server could run any program on the machine
 * with no approval prompt in the way, which is not a tool call — it is a shell.
 */

/** userId → Map(serverId → { connection, tools, error, at }) */
const live = new Map();

/** How long a failed connection is remembered before trying again. */
const RETRY_AFTER_MS = 60_000;

const PREFIX = 'mcp__';
export const isMcpTool = (name) => String(name || '').startsWith(PREFIX);

/** `mcp__figma__get_file` → `{ server: 'figma', tool: 'get_file' }` */
export function splitMcpName(name) {
  const rest = String(name).slice(PREFIX.length);
  const cut = rest.indexOf('__');
  if (cut < 1) return null;
  return { server: rest.slice(0, cut), tool: rest.slice(cut + 2) };
}

/**
 * A server id safe to put in a tool name.
 *
 * Tool names are matched exactly by every provider and several of them reject
 * anything outside `[a-zA-Z0-9_-]`, so a server called "My Figma!" has to become
 * something a model can actually be offered.
 */
export const slugify = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'server';

function stored(row) {
  const config = { ...(row.config || {}) };
  // Headers may carry a bearer token, so they are encrypted at rest like every
  // other credential in this app and decrypted only here.
  if (config.headersCipher) {
    try {
      config.headers = JSON.parse(decryptSecret(config.headersCipher) || '{}');
    } catch {
      config.headers = {};
    }
    delete config.headersCipher;
  }
  if (config.envCipher) {
    try {
      config.env = JSON.parse(decryptSecret(config.envCipher) || '{}');
    } catch {
      config.env = {};
    }
    delete config.envCipher;
  }
  return config;
}

/** Encrypt the parts of a config that are secrets, for storage. */
export function sealConfig(config = {}) {
  const out = { ...config };
  if (out.headers && Object.keys(out.headers).length) {
    out.headersCipher = encryptSecret(JSON.stringify(out.headers));
  }
  delete out.headers;
  if (out.env && Object.keys(out.env).length) {
    out.envCipher = encryptSecret(JSON.stringify(out.env));
  }
  delete out.env;
  return out;
}

/**
 * Connect to every enabled server for this account, and list their tools.
 *
 * A server that will not start is **not** an error for the turn. It is recorded,
 * reported in the interface, and skipped — one broken server must not take the
 * assistant's own tools away with it. The failure is remembered for a minute so a
 * server that is down does not cost a handshake timeout on every single message.
 */
export async function mcpTools(userId) {
  const store = getStore();
  let rows;
  try {
    rows = await store.listMcpServers(userId);
  } catch {
    // The table may not exist yet on a database mid-migration. No MCP is a
    // perfectly workable state; a crashed turn is not.
    return { tools: [], servers: [] };
  }

  const enabled = rows.filter((row) => row.enabled !== false);
  if (!enabled.length) return { tools: [], servers: [] };

  if (!live.has(userId)) live.set(userId, new Map());
  const mine = live.get(userId);

  const tools = [];
  const servers = [];

  await Promise.all(
    enabled.map(async (row) => {
      const id = slugify(row.name);
      const held = mine.get(id);

      // Drop a connection whose transport has died, so the next turn reconnects
      // rather than reporting tools that can no longer be called.
      if (held?.connection?.transport?.closed) mine.delete(id);
      const current = mine.get(id);

      if (current?.error && Date.now() - current.at < RETRY_AFTER_MS) {
        servers.push({ id, name: row.name, error: current.error, tools: 0 });
        return;
      }

      if (current?.connection) {
        tools.push(...current.tools);
        servers.push({ id, name: row.name, tools: current.tools.length, server: current.connection.server });
        return;
      }

      try {
        const connection = await connectMcp(stored(row));
        const advertised = connection.tools.map((tool) => ({
          name: `${PREFIX}${id}${'__'}${tool.name}`,
          scope: 'mcp',
          // Everything from outside is treated as changing something. See
          // `assessRisk`: an unrecognised tool is already graded sensitive, and
          // that is the behaviour wanted here rather than an exception to it.
          readOnly: false,
          description:
            `[${row.name}] ${tool.description || tool.title || 'No description given by the server.'}`.slice(0, 1024),
          parameters: tool.inputSchema || { type: 'object', properties: {} },
        }));

        mine.set(id, { connection, tools: advertised, error: null, at: Date.now() });
        tools.push(...advertised);
        servers.push({ id, name: row.name, tools: advertised.length, server: connection.server });
      } catch (err) {
        mine.set(id, { connection: null, tools: [], error: err.message, at: Date.now() });
        servers.push({ id, name: row.name, error: err.message, tools: 0 });
      }
    }),
  );

  return { tools, servers };
}

/** Run one MCP tool by its prefixed name. */
export async function callMcpTool(userId, name, input, timeoutMs) {
  const split = splitMcpName(name);
  if (!split) throw new Error(`"${name}" is not a valid MCP tool name.`);

  // Connect if this is the first call of the process — the agent loop lists tools
  // before calling them, so normally the connection is already here.
  if (!live.get(userId)?.get(split.server)?.connection) await mcpTools(userId);

  const held = live.get(userId)?.get(split.server);
  if (!held?.connection) {
    throw new Error(
      held?.error
        ? `The "${split.server}" MCP server is not reachable: ${held.error}`
        : `There is no MCP server called "${split.server}" on this account.`,
    );
  }

  return held.connection.call(split.tool, input, timeoutMs);
}

/**
 * Try a configuration without saving it.
 *
 * What the interface needs before storing anything: does it start, and what does
 * it offer. Saving a server that cannot start would put a permanent error in
 * somebody's settings for them to work out later.
 */
export async function probeMcpServer(config) {
  const connection = await connectMcp(config);
  try {
    return {
      server: connection.server,
      protocolVersion: connection.protocolVersion,
      tools: connection.tools.map((tool) => ({ name: tool.name, description: tool.description || '' })),
    };
  } finally {
    connection.close();
  }
}

/**
 * Which servers are reachable right now, for the settings page.
 *
 * The same work as `mcpTools` and deliberately the same call, so the page shows
 * the state the next turn will actually get rather than a second opinion. Asked
 * for on each visit rather than stored, because "it worked when I added it" is
 * exactly the fact that goes stale.
 */
export async function mcpStatus(userId) {
  const { servers } = await mcpTools(userId);
  return { servers };
}

/** Drop cached connections for an account, so the next turn reconnects. */
export function forgetMcp(userId) {
  const mine = live.get(userId);
  if (!mine) return;
  for (const [, held] of mine) held.connection?.close?.();
  live.delete(userId);
}

/** Close everything. Called when the process is going down. */
export function closeAllMcp() {
  for (const [userId] of live) forgetMcp(userId);
}

export const __testing = { live, slugify, splitMcpName };
