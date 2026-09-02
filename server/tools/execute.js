import crypto from 'node:crypto';
import { getStore } from '../store/index.js';
import { usesInProcessTools, inProcessImplementations, workerStatus } from '../localTools.js';
import { getPrefs } from '../settings.js';
import { TOOLS_BY_NAME } from './definitions.js';
import { CLOUD_IMPLEMENTATIONS } from './cloud.js';
import { isMcpTool, callMcpTool, splitMcpName } from '../mcp/registry.js';
import { keepStepShot } from '../attachments.js';
import { redactSecrets } from '../redact.js';
import { untrusted } from './untrusted.js';

const POLL_MS = 400;
const DEFAULT_LOCAL_TIMEOUT_MS = 180_000;

/**
 * A tool's failure, with any credential taken out of it.
 *
 * `readableFailure` already does this for a provider error that ends a turn,
 * and the unattended runners do it for a step's stored error. This is the third
 * channel and it was the one still open, because it does not look like a place
 * a provider key could appear.
 *
 * It is. `web_extract` and `deep_research` call a model *inside* a tool, so a
 * client handed a malformed key reports it by quoting the value back — and that
 * sentence becomes this tool's result, which is worse than the other two
 * channels rather than better. A turn's error is shown once; a tool result is
 * streamed to the browser, written into `messages`, and then re-sent to the
 * model on every remaining step of the turn.
 *
 * The same treatment covers an MCP server that echoes its own bearer token, and
 * a worker whose shell printed an environment variable.
 */
const safeError = (error) => redactSecrets(String(error?.message ?? error ?? '')).text;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Hand a local tool call to the worker on this user's machine and wait.
 *
 * The worker cannot be dialled into from the internet, so a queue row is the
 * rendezvous point. Both the enqueue and the claim are scoped by `userId`,
 * which is what guarantees a job can only ever run on its own owner's computer.
 */
async function runViaWorker({ user, userId, name, input, chatId, timeoutMs, signal, deviceHint }) {
  const store = getStore();

  // Addressed to one machine rather than left for whoever polls first. With two
  // computers paired, an unaddressed job is a coin toss — and "read that file"
  // landing on the wrong laptop is a confusing failure at best and the wrong
  // file at worst.
  const prefs = await getPrefs(userId);
  const status = await workerStatus(user || { id: userId }, prefs, deviceHint);
  if (!status.online) {
    return {
      isError: true,
      content:
        'No computer is connected to this account, so this tool cannot run. Tell the user to start the AI Remote worker on their machine — Settings → Computers has a pairing code — or solve the task with the web tools instead.',
    };
  }

  const id = crypto.randomUUID();
  await store.enqueueJob(userId, { id, chatId, tool: name, input, deviceId: status.activeId });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await store.completeJob(userId, id, { status: 'error', result: { error: 'Cancelled by the user.' } });
      return { isError: true, content: 'Cancelled by the user.' };
    }
    await sleep(POLL_MS);
    const job = await store.getJob(userId, id);
    if (!job || job.status === 'pending' || job.status === 'running') continue;

    const result = job.result || {};
    if (job.status === 'error' || result.error) {
      return { isError: true, content: safeError(result.error) || 'The worker reported an error.' };
    }

    /**
     * The worker moved its workspace; remember where.
     *
     * The worker has no database of its own, so a change it makes lives only in
     * its memory and is lost the moment it restarts. Writing it to the device
     * row here is what makes "work in D:\projects from now on" mean *from now
     * on*, rather than until the next reboot — and it is the same field the app
     * writes, so both routes end up in one place.
     */
    if (name === 'set_workspace' && status.activeId) {
      await store
        .setDeviceWorkspace(userId, status.activeId, String(input?.path || '') || null)
        .catch(() => {});
    }

    // `shot` is a reference to an attachment the worker's result endpoint has
    // already stored — see `keepStepShot`. It rides out to the browser beside
    // the text, the same way `file` and `widget` do for cloud tools.
    return { isError: false, content: String(result.output ?? ''), shot: result.shot || undefined };
  }

  await store.completeJob(userId, id, { status: 'error', result: { error: 'Timed out.' } });
  return {
    isError: true,
    content: `The worker did not answer within ${Math.round(timeoutMs / 1000)}s. It may be offline, or the command may have hung.`,
  };
}

/**
 * Run one tool call and return `{content, isError}` — never throws, because a
 * thrown error would break the agent loop where the model could otherwise read
 * the failure and adjust.
 */
export async function executeTool({ user, name, input, chatId, signal, deviceHint }) {
  const userId = user.id;

  /**
   * MCP tools are not in `TOOLS_BY_NAME`, and cannot be.
   *
   * They are discovered per account at the start of a turn, so the static
   * catalogue has never heard of them. Routed by prefix *before* the lookup
   * below, which would otherwise reject every one of them as unknown.
   */
  if (isMcpTool(name)) {
    try {
      const { text, isError } = await callMcpTool(userId, name, input || {}, Number(input?.timeout_ms) || undefined);
      /**
       * Wrapped, because this is code from outside the repository returning text
       * straight into the model's context. The tool is already graded
       * `sensitive` so a person sees the call — but they see the *call*, not
       * what it hands back, and what it hands back is the half that could carry
       * an instruction. See server/tools/untrusted.js.
       */
      return { isError, content: untrusted(`the ${splitMcpName(name)?.server || 'MCP'} server`, text) };
    } catch (err) {
      return { isError: true, content: `${name} failed: ${safeError(err) || String(err)}` };
    }
  }

  const def = TOOLS_BY_NAME[name];
  if (!def) return { isError: true, content: `Unknown tool "${name}".` };

  try {
    if (def.scope === 'cloud') {
      const impl = CLOUD_IMPLEMENTATIONS[name];
      if (!impl) return { isError: true, content: `Tool "${name}" has no implementation.` };
      // The whole user, not just the id: delegating to sub-agents needs the
      // account's model, preferences and worker, not merely a key to scope by.
      const result = await impl(input || {}, { userId, user, chatId, signal });

      /**
       * A tool may hand back more than a sentence.
       *
       * `create_file` produces something the interface has to show — a card with
       * a preview and a download — and that cannot be expressed in the text the
       * model reads. So an implementation may return `{ content, file }`, and
       * the extra travels out with the tool result to the browser. Everything
       * else still returns a string and is untouched.
       */
      if (result && typeof result === 'object' && 'content' in result) {
        return { isError: false, content: String(result.content ?? ''), file: result.file };
      }
      return { isError: false, content: String(result ?? '') };
    }

    // Running on the owner's own machine: no queue, no second process.
    if (usesInProcessTools(user)) {
      const impl = (await inProcessImplementations(user))[name];
      if (!impl) return { isError: true, content: `Tool "${name}" has no implementation.` };
      // The same second argument the worker passes, so a locally-run server and
      // a paired machine behave identically — a difference here would show up as
      // "it isolates conversations on my laptop but not on the VM".
      const output = await impl(input || {}, { chatId: chatId ?? null });

      /**
       * The same two result shapes the worker's job runner handles.
       *
       * This branch is easy to forget and expensive to get wrong: the browser
       * tools return `{ text, shot }` now, and stringifying that object gives
       * the model "[object Object]" as its view of the page. The failure is
       * silent — the tool call succeeds — and it happens only on a locally-run
       * server, which is the configuration most people develop against.
       */
      if (output && typeof output === 'object' && !Array.isArray(output)) {
        return {
          isError: false,
          content: String(output.text ?? ''),
          shot: output.shot ? await keepStepShot(userId, output.shot) : undefined,
        };
      }
      return { isError: false, content: String(output ?? '') };
    }

    const timeoutMs = Math.min(Number(input?.timeout_ms) || DEFAULT_LOCAL_TIMEOUT_MS, 600_000);
    return await runViaWorker({ user, userId, name, input: input || {}, chatId, timeoutMs, signal, deviceHint });
  } catch (err) {
    return { isError: true, content: `${name} failed: ${safeError(err) || String(err)}` };
  }
}
