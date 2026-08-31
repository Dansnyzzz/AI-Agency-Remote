/**
 * The MCP client, against a server that really speaks the protocol.
 *
 *   node test/mcp.test.mjs
 *
 * MCP is what makes this app's tool list open rather than fixed, so the client
 * has to be right about the awkward parts rather than the happy path. Every check
 * here covers something that silently produces "no tools available":
 *
 *   - `tools/list` before `initialize` is refused by real servers
 *   - the tool list is paginated, and page two is where half of it lives
 *   - servers print banners to stdout, which is not a protocol error
 *   - a failed tool is a result with `isError`, not a JSON-RPC error
 *   - a server that cannot start has to say *why*, or the interface shows nothing
 *
 * And the one that is not about the protocol at all: a tool from outside this
 * repository must always stop for approval.
 */
import path from 'node:path';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

// stdio spawns a process the user named, so it is off unless switched on. The
// suite drives a trusted stub over stdio, which is exactly the case the switch
// exists for: a self-hosted owner who has opted in.
process.env.ALLOW_MCP_STDIO = '1';

const { connectMcp, __testing } = await import('../server/mcp/client.js');
const { flatten } = __testing;
const { slugify, splitMcpName } = (await import('../server/mcp/registry.js')).__testing;
const { assessRisk, riskReason, availableTools } = await import('../server/tools/definitions.js');

const STUB = path.join(import.meta.dirname, 'fixtures', 'mcp-stub-server.mjs');
const stub = (mode) => ({
  transport: 'stdio',
  command: process.execPath,
  args: [STUB],
  env: mode ? { MCP_STUB_MODE: mode } : {},
});

section('the handshake, and what it unlocks');
{
  const mcp = await connectMcp(stub());
  check('it connects', !!mcp);
  check('and reports who answered', mcp.server?.name === 'stub', JSON.stringify(mcp.server));
  check('with a protocol version', !!mcp.protocolVersion, mcp.protocolVersion);

  // Page two is where three of the five live. A client that stops at the first
  // page reports a server as smaller than it is, and nothing looks broken.
  check('every page of the tool list is read', mcp.tools.length === 5, `${mcp.tools.length} tools`);
  check(
    'including the ones past the first page',
    mcp.tools.some((t) => t.name === 'explode'),
    mcp.tools.map((t) => t.name).join(', '),
  );
  mcp.close();
}

section('calling a tool');
{
  const mcp = await connectMcp(stub());

  const echo = await mcp.call('echo', { message: 'xin chào' });
  check('arguments arrive', echo.text === 'echo: xin chào', echo.text);
  check('and it is not marked as an error', echo.isError === false);

  const sum = await mcp.call('add', { a: 2, b: 40 });
  check('numbers survive the trip', sum.text === '42', sum.text);

  /**
   * A tool that failed is a *result*, not a transport error.
   *
   * Conflating the two is the classic mistake: the message the server took the
   * trouble to write gets replaced by a generic failure, and the model retries
   * the same call because it never learned what went wrong.
   */
  const boom = await mcp.call('explode', {});
  check('a failing tool is flagged', boom.isError === true);
  check('and its message survives', /exploded/.test(boom.text), boom.text);

  // Some servers answer with structuredContent and no content list at all.
  const structured = await mcp.call('structured', {});
  check('structuredContent is not dropped', /rows/.test(structured.text), structured.text.slice(0, 60));

  // An image cannot go into a tool result here. Naming it beats dropping it —
  // a silently missing attachment is worse than a sentence saying one arrived.
  const picture = await mcp.call('picture', {});
  check('an image is named rather than lost', /image\/png/.test(picture.text), picture.text);

  let refused = '';
  try {
    await mcp.call('nope', {});
  } catch (err) {
    refused = err.message;
  }
  check('an unknown tool fails loudly', /Unknown tool/.test(refused), refused);
  mcp.close();
}

section('servers that misbehave');
{
  // A banner on stdout is not a protocol error, and treating it as one would rule
  // out a good number of real servers.
  const noisy = await connectMcp(stub('noisy'));
  check('a startup banner on stdout is ignored', noisy.tools.length === 5, `${noisy.tools.length} tools`);
  noisy.close();

  let greetError = '';
  try {
    await connectMcp(stub('nogreet'));
  } catch (err) {
    greetError = err.message;
  }
  check('a refused handshake surfaces the reason', /refuses to initialise/.test(greetError), greetError);

  // The reason a server did not start is the only thing anybody can act on, so a
  // process that dies has to carry its stderr out with it.
  let deadError = '';
  try {
    await connectMcp({ transport: 'stdio', command: process.execPath, args: ['-e', 'process.stderr.write("boom: missing config\\n");process.exit(2)'] });
  } catch (err) {
    deadError = err.message;
  }
  check('a process that exits reports its exit code', /code 2/.test(deadError), deadError.slice(0, 90));
  check('and what it said on stderr', /missing config/.test(deadError));

  let missingError = '';
  try {
    await connectMcp({ transport: 'stdio', command: 'definitely-not-a-real-program-xyz', args: [] });
  } catch (err) {
    missingError = err.message;
  }
  check('a command that does not exist fails clearly', missingError.length > 0, missingError.slice(0, 90));
}

section('names');
{
  // Providers reject tool names outside [A-Za-z0-9_-], so a server called
  // "My Figma!" has to become something a model can actually be offered.
  check('a name is made safe for a tool id', slugify('My Figma!') === 'my_figma', slugify('My Figma!'));
  check('and never comes back empty', slugify('!!!') === 'server', slugify('!!!'));
  check('a prefixed name splits back apart', JSON.stringify(splitMcpName('mcp__figma__get_file')) === '{"server":"figma","tool":"get_file"}');
  // Tool names containing __ must not be truncated at the first one.
  check(
    'a tool whose own name has __ in it survives',
    splitMcpName('mcp__db__run__query')?.tool === 'run__query',
    JSON.stringify(splitMcpName('mcp__db__run__query')),
  );
  check('nonsense is refused', splitMcpName('mcp__nope') === null);
}

section('a tool from outside this app always asks');
{
  check('it is graded sensitive', assessRisk('mcp__figma__delete_everything', {}) === 'sensitive');
  const reason = riskReason('mcp__figma__delete_everything', {});
  check('and the prompt says where it came from', /figma/.test(reason) && /outside/.test(reason), reason);

  // Under the read-only policies it must not be offered at all: it is not
  // readOnly, and nothing here can prove otherwise.
  const extra = [{ name: 'mcp__x__do', scope: 'mcp', readOnly: false, description: 'd', parameters: { type: 'object', properties: {} } }];
  const offered = (policy) => availableTools({ workerOnline: true, desktopOnline: false, policy, extra }).map((t) => t.name);
  check('offered under guarded', offered('guarded').includes('mcp__x__do'));
  check('withheld under read-only', !offered('readonly').includes('mcp__x__do'));
  check('and withheld in plan mode', !offered('plan').includes('mcp__x__do'));
}

section('stdio runs a real command, so it is off unless switched on');
{
  // The one that ends the project if it is wrong: a stdio server spawns a
  // process, which inherits the server's environment — every stored account's
  // keys are decryptable by whatever that process wants to read. So the reach
  // is denied by default, and a self-hosting owner opts in knowingly.
  const saved = process.env.ALLOW_MCP_STDIO;
  delete process.env.ALLOW_MCP_STDIO;
  let refused = '';
  try {
    await connectMcp(stub());
  } catch (err) {
    refused = err.message;
  }
  check('a stdio server is refused when nobody opted in', /ALLOW_MCP_STDIO/.test(refused), refused);
  process.env.ALLOW_MCP_STDIO = saved;

  // Shared infrastructure never runs an arbitrary command, opt-in or not: on a
  // multi-tenant deployment one account's command reads every account's secrets.
  const savedVercel = process.env.VERCEL;
  process.env.VERCEL = '1';
  let onServerless = '';
  try {
    await connectMcp(stub());
  } catch (err) {
    onServerless = err.message;
  }
  check('and refused on serverless even with the switch on', onServerless.length > 0, onServerless);
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
}

section('an http server may not be pointed at a private address');
{
  // The model, or a user, supplies this URL. Without a check the server fetches
  // whatever it names — including cloud metadata at 169.254.169.254, which on a
  // hosted deployment hands out credentials.
  let metadata = '';
  try {
    await connectMcp({ transport: 'http', url: 'http://169.254.169.254/latest/meta-data/' });
  } catch (err) {
    metadata = err.message;
  }
  check('cloud metadata is refused', /private address|public internet/i.test(metadata), metadata);

  let loopback = '';
  try {
    await connectMcp({ transport: 'http', url: 'http://127.0.0.1:1/' });
  } catch (err) {
    loopback = err.message;
  }
  check('and so is loopback', /private|public internet/i.test(loopback), loopback);
}

section('flattening a result');
{
  check('plain text passes through', flatten({ content: [{ type: 'text', text: 'hello' }] }) === 'hello');
  check('several parts are joined', flatten({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }) === 'a\nb');
  check('an embedded resource shows its text', /inside/.test(flatten({ content: [{ type: 'resource', resource: { text: 'inside' } }] })));
  check('a link is named', /uri:x/.test(flatten({ content: [{ type: 'resource_link', uri: 'uri:x' }] })));
  // Nothing at all still has to read as nothing, not as a crash.
  check('an empty result says so', flatten({ content: [] }) === '(the server returned nothing)');
  check('and a missing content list does not throw', typeof flatten(undefined) === 'string');
}

section('a server plugged in reaches the assistant');
{
  /**
   * The whole point, end to end.
   *
   * Everything above proves the client speaks the protocol. This proves the part
   * that actually matters: a row in the database becomes a tool the model is
   * offered, under a name it can call, executed through the normal path — and
   * scoped to the account that added it.
   */
  const os = await import('node:os');
  const fsp = await import('node:fs');
  const dir = path.join(os.tmpdir(), `ai-remote-mcp-test-${process.pid}`);
  fsp.rmSync(dir, { recursive: true, force: true });

  process.env.ENCRYPTION_KEY ||= 'mcp-test-encryption-key';
  process.env.DATA_DIR = dir;

  const { initStore, getStore } = await import('../server/store/index.js');
  await initStore();
  const store = getStore();

  const mine = await store.createUser({ id: 'user-a', email: 'a@example.com', passwordHash: 'x', role: 'admin' });
  const theirs = await store.createUser({ id: 'user-b', email: 'b@example.com', passwordHash: 'x', role: 'user' });

  const { sealConfig, mcpTools, forgetMcp } = await import('../server/mcp/registry.js');
  await store.saveMcpServer(mine.id, {
    id: 'srv-1',
    name: 'Stub Server',
    config: sealConfig({ transport: 'stdio', command: process.execPath, args: [STUB] }),
    enabled: true,
  });

  const offered = await mcpTools(mine.id);
  check('the server is reached', offered.servers[0] && !offered.servers[0].error, JSON.stringify(offered.servers[0]));
  check('its tools are advertised', offered.tools.length === 5, `${offered.tools.length} tools`);
  // Prefixed, so a server called `filesystem` cannot shadow this app's own
  // `read_file` — a silent substitution would be very hard to notice.
  check(
    'under a prefixed name',
    offered.tools.some((t) => t.name === 'mcp__stub_server__echo'),
    offered.tools.map((t) => t.name).join(', '),
  );
  check('and the name says which server', offered.tools.every((t) => t.description.startsWith('[Stub Server]')));

  // Through the executor the agent loop actually uses, not a direct call.
  const { executeTool } = await import('../server/tools/execute.js');
  const ran = await executeTool({
    user: mine,
    name: 'mcp__stub_server__echo',
    input: { message: 'through the executor' },
    chatId: null,
  });
  check('it runs through the normal tool path', ran.content === 'echo: through the executor', ran.content);
  check('and is not reported as an error', !ran.isError);

  const failed = await executeTool({ user: mine, name: 'mcp__stub_server__explode', input: {}, chatId: null });
  check('a failing MCP tool comes back as an error', failed.isError === true, failed.content);

  /**
   * The tenancy boundary, which for MCP is not merely about privacy.
   *
   * A stdio server is a program that runs on the machine. One account being able
   * to see another's row would be one account choosing what another account
   * executes, so this is checked rather than assumed.
   */
  const others = await mcpTools(theirs.id);
  check('another account sees none of it', others.tools.length === 0 && others.servers.length === 0);
  const denied = await executeTool({ user: theirs, name: 'mcp__stub_server__echo', input: { message: 'hi' }, chatId: null });
  check('and cannot call it either', denied.isError === true, denied.content.slice(0, 80));

  // Disabling has to take the tools away, or the switch is decoration.
  await store.setMcpServerEnabled(mine.id, 'srv-1', false);
  forgetMcp(mine.id);
  const off = await mcpTools(mine.id);
  check('disabling a server withdraws its tools', off.tools.length === 0, `${off.tools.length} tools`);

  forgetMcp(mine.id);
  forgetMcp(theirs.id);
  await store.close?.();
  fsp.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failures === 0
    ? '\n\x1b[32mAll MCP checks passed.\x1b[0m\n'
    : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
