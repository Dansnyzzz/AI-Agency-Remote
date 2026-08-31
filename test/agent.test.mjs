/**
 * Agent-loop suite — the parts with no network and no browser.
 *
 * Separate from the tenancy suite because the shape of the work is different:
 * this drives the loop with a stubbed provider, rather than running SQL and
 * trying to cross a boundary. Both are fast, so `npm test` runs both.
 *
 * The reason this file exists at all is `run_parallel`. It shipped calling an
 * async generator with `await`, which hands back the generator untouched: no
 * request was ever sent, every sub-agent answered "(no answer)" in zero seconds,
 * and nothing noticed, because nothing tested it.
 *
 *   node test/agent.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'agent-test-encryption-key';
process.env.SESSION_SECRET ||= 'agent-test-session-secret';
// A real store, in a throwaway directory — cheaper and more honest than a hook
// in production code for swapping the store out.
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-agent-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const { initStore } = await import('../server/store/index.js');
const store = await initStore();

const { hashPassword } = await import('../server/crypto.js');
const { runParallel } = await import('../server/subagents.js');
const { normaliseOrder, needsApproval } = await import('../server/agent.js');

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

const user = await store.createUser({
  id: 'u-sub',
  email: 'sub@example.com',
  name: 'Sub',
  passwordHash: await hashPassword('a-sufficiently-long-password'),
  role: 'admin',
});

/**
 * A provider that answers without a network.
 *
 * It can only be reached by iterating it, which is the whole assertion: the old
 * code awaited the generator and therefore never entered this function at all.
 */
function scriptedProvider(turns) {
  const queue = [...turns];
  const seen = { calls: 0, userIds: [], tools: null, system: null };

  const stream = async function* fake(opts) {
    seen.calls += 1;
    seen.userIds.push(opts.userId);
    seen.tools = opts.tools;
    seen.system = opts.system;
    const turn = queue.shift() || { text: '' };
    if (turn.throws) throw new Error(turn.throws);
    if (turn.text) yield { type: 'text', delta: turn.text };
    yield {
      type: 'done',
      stopReason: 'end_turn',
      toolCalls: turn.toolCalls || [],
      usage: { input: 100, output: 40 },
    };
  };
  return { stream, seen };
}

// ── sub-agents actually run ──────────────────────────────────────────
section('sub-agents (run_parallel)');
{
  const { stream, seen } = scriptedProvider([
    { text: 'Answer about the first thing.' },
    { text: 'Answer about the second thing.' },
  ]);

  const output = await runParallel({
    user,
    chatId: null,
    tasks: ['What is in file A?', 'What is in file B?'],
    stream,
  });

  check('the provider was actually driven', seen.calls === 2, `${seen.calls} calls`);
  check('answers come back, not "(no answer)"', !output.includes('(no answer)'), output.slice(0, 80));
  check('the first answer is present', output.includes('Answer about the first thing.'));
  check('the second answer is present', output.includes('Answer about the second thing.'));
  check(
    'both tasks are labelled',
    output.includes('1. What is in file A?') && output.includes('2. What is in file B?'),
  );
  check('tokens are counted, not zero', /\b280 tokens\b/.test(output), output.split('\n')[0]);

  // The other half of the same bug: the key lookup is scoped by account, and the
  // caller was passing the whole user object where the id belonged.
  check(
    'the account id reaches the provider',
    seen.userIds.every((id) => id === 'u-sub'),
    JSON.stringify(seen.userIds),
  );
}

section('sub-agent spend is recorded');
{
  const usage = await store.usageThisMonth(user.id);
  check('usage was written', usage.tokens === 280, `${usage.tokens} tokens`);
  // The default model is anthropic/claude-opus-5 at $5/$25 per 1M, so 200 in and
  // 80 out is real money — it used to be booked at exactly zero.
  check('and priced rather than booked at zero', usage.cost > 0, `$${usage.cost}`);
}

section('sub-agent limits');
{
  const { stream } = scriptedProvider([]);
  let refused = '';
  try {
    await runParallel({ user, chatId: null, tasks: Array.from({ length: 9 }, (_, i) => `task ${i}`), stream });
  } catch (err) {
    refused = err.message;
  }
  check('more than six tasks is refused', /6 at once is the limit/.test(refused), refused);

  let empty = '';
  try {
    await runParallel({ user, chatId: null, tasks: [], stream });
  } catch (err) {
    empty = err.message;
  }
  check('no tasks at all is refused', /at least one task/.test(empty), empty);
}

section('a failing sub-agent is reported as failed');
{
  const { stream } = scriptedProvider([{ throws: 'the provider fell over' }]);
  const output = await runParallel({ user, chatId: null, tasks: ['anything'], stream });

  check('the failure is surfaced', /Failed: the provider fell over/.test(output), output.slice(0, 90));
  check(
    'and the summary says so rather than implying success',
    /1 of them failed/.test(output),
    output.split('\n')[0],
  );
}

section('sub-agents may only use read-only tools');
{
  // The tool list handed to a sub-agent is already read-only, so a mutating call
  // means the model invented a name. It must be refused rather than executed.
  const { stream } = scriptedProvider([
    { text: '', toolCalls: [{ id: 't1', name: 'write_file', input: { path: 'x.txt', content: 'y' } }] },
    { text: 'I could not do that, but here is what I found.' },
  ]);

  const output = await runParallel({ user, chatId: null, tasks: ['try to write a file'], stream });
  check(
    'a mutating tool call is not executed',
    output.includes('I could not do that'),
    output.slice(-120),
  );
}

// ── the transcript reordering the main loop depends on ───────────────
section('normaliseOrder edge cases');
{
  const messy = normaliseOrder([
    { id: '1', role: 'user' },
    { id: '2', role: 'assistant', toolCalls: [{ id: 'a' }] },
    { id: '3', role: 'user', text: 'wait' },
    { id: '4', role: 'tool', results: [] },
    { id: '5', role: 'assistant', toolCalls: [{ id: 'b' }] },
    { id: '6', role: 'tool', results: [] },
  ]);
  check(
    'each tool message still follows its own call',
    messy.map((m) => m.role).join(',') === 'user,assistant,tool,user,assistant,tool',
    messy.map((m) => m.role).join(','),
  );
  check('nothing is dropped', messy.length === 6);

  // A run cut off before its results arrived: the trailing call has no answer,
  // and re-ordering must neither invent one nor lose the interruption.
  const truncated = normaliseOrder([
    { id: '1', role: 'assistant', toolCalls: [{ id: 'a' }] },
    { id: '2', role: 'user', text: 'still here?' },
  ]);
  check(
    'an unanswered call keeps the later message',
    truncated.map((m) => m.id).join(',') === '1,2',
    truncated.map((m) => m.id).join(','),
  );
  check('an empty transcript is fine', normaliseOrder([]).length === 0);
}

// ── keeping a long conversation inside the window ───────────────────
section('measuring how full the window is');
{
  const { measure } = await import('../server/compact.js');
  const entry = { context: 100_000 };

  const empty = measure([], entry, { maxOutput: 10_000 });
  check('an empty conversation uses nothing', empty.used === 0 && empty.ratio === 0);
  check('and the budget leaves room for the reply', empty.budget === 90_000, String(empty.budget));

  // The honest number comes from the provider: every assistant turn records the
  // prompt size it was actually billed for.
  const counted = measure(
    [
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi', usage: { input: 45_000, output: 100 } },
    ],
    entry,
    { maxOutput: 10_000 },
  );
  check('a real usage figure is used verbatim', counted.used === 45_000, String(counted.used));
  check('and is marked exact', counted.exact === true);
  check('half the budget reads as half', Math.abs(counted.ratio - 0.5) < 0.01, String(counted.ratio));

  // Anything after the last counted turn is estimated, because nobody has
  // counted it yet.
  const withTail = measure(
    [
      { role: 'assistant', text: 'hi', usage: { input: 45_000 } },
      { role: 'user', text: 'x'.repeat(4000) },
    ],
    entry,
    { maxOutput: 10_000 },
  );
  check('the tail is estimated on top', withTail.used > 45_000, String(withTail.used));
  check('and it says the number is not exact', withTail.exact === false);

  // A model that never said how big its window is still gets a gauge.
  const unknown = measure([{ role: 'assistant', usage: { input: 1000 } }], {}, { maxOutput: 1000 });
  check('an unknown window falls back rather than dividing by nothing', unknown.context > 0, String(unknown.context));

  // Images are not characters, and pretending a screenshot is free would make
  // the gauge lie exactly when it matters.
  const withImage = measure(
    [{ role: 'user', text: 'look', attachments: [{ kind: 'image' }] }],
    entry,
    { maxOutput: 10_000 },
  );
  check('an image costs something', withImage.used > 500, String(withImage.used));
}

section('deciding when to fold');
{
  const { shouldCompact } = await import('../server/compact.js');
  const entry = { context: 100_000 };
  const filler = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));

  const roomy = [...filler, { role: 'assistant', usage: { input: 20_000 } }];
  check('a conversation with room is left alone', shouldCompact(roomy, entry, { maxOutput: 10_000 }) === false);

  const full = [...filler, { role: 'assistant', usage: { input: 85_000 } }];
  check('a nearly full one is folded', shouldCompact(full, entry, { maxOutput: 10_000 }) === true);

  // Nothing to gain from summarising a conversation that is almost all tail.
  const shortButFull = [{ role: 'assistant', usage: { input: 89_000 } }];
  check(
    'a short conversation is never folded, however full',
    shouldCompact(shortButFull, entry, { maxOutput: 10_000 }) === false,
    'there would be nothing left to keep',
  );
}

section('the fold never splits a tool call from its result');
{
  const { tailStart } = await import('../server/compact.js');

  // Every provider rejects a `tool` message whose call it cannot see, so a
  // boundary in the wrong place turns a working conversation into a 400.
  const messages = [
    { role: 'user', text: 'a' },
    { role: 'assistant', toolCalls: [{ id: '1' }] },
    { role: 'tool', results: [] },
    { role: 'assistant', toolCalls: [{ id: '2' }] },
    { role: 'tool', results: [] },
    { role: 'assistant', text: 'done' },
  ];

  for (let keep = 1; keep <= messages.length; keep += 1) {
    const start = tailStart(messages, keep);
    if (messages[start]?.role === 'tool') {
      check(`keep=${keep} never starts the tail on a tool result`, false, `start=${start}`);
    }
  }
  check('no keep length produces an orphaned tool result', true, 'checked every boundary');

  check('the boundary walks back past a tool message', tailStart(messages, 2) === 3, String(tailStart(messages, 2)));
  check('and keeps the whole thing when asked for more than there is', tailStart(messages, 99) === 0);
}

section('what the model is sent after a fold');
{
  const { activeTranscript } = await import('../server/compact.js');

  const plain = [
    { id: '1', role: 'user', text: 'a' },
    { id: '2', role: 'assistant', text: 'b' },
  ];
  check('with no summary, everything is sent', activeTranscript(plain).length === 2);

  const folded = [
    { id: '1', role: 'user', text: 'old thing' },
    { id: '2', role: 'assistant', text: 'old reply' },
    { id: '3', role: 'summary', text: 'They asked about X. The file is src/app.js.' },
    { id: '4', role: 'user', text: 'carry on' },
  ];
  const sent = activeTranscript(folded);
  check('after a fold, the old turns are not sent', sent.length === 2, `${sent.length} messages`);
  check('the summary comes first', sent[0].role === 'user' && /src\/app\.js/.test(sent[0].text));
  check('framed so the model knows what it is', /folded up to save room/.test(sent[0].text));
  check('and what followed is sent verbatim', sent[1].text === 'carry on');

  // Compacting again must summarise the previous summary too, or the cost grows
  // with every fold instead of staying flat.
  const twice = [
    ...folded,
    { id: '5', role: 'summary', text: 'Second summary covering everything above.' },
    { id: '6', role: 'user', text: 'and now this' },
  ];
  const again = activeTranscript(twice);
  check('a second fold supersedes the first', again.length === 2, `${again.length} messages`);
  check('using the newer summary', /Second summary/.test(again[0].text));
}

section('folding a conversation');
{
  const { compact } = await import('../server/compact.js');
  const chat = await store.createChat(user.id, { id: 'c-compact', title: 'Long one', model: 'm' });

  const messages = [];
  for (let i = 0; i < 14; i += 1) {
    messages.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `turn number ${i}` });
  }

  const { stream, seen } = scriptedProvider([{ text: 'They worked through fourteen turns about X.' }]);
  const summary = await compact({
    userId: user.id,
    chatId: chat.id,
    entry: { id: 'anthropic/claude-opus-5', provider: 'anthropic', model: 'x', context: 100_000 },
    prefs: { effort: 'high' },
    messages,
    stream,
  });

  check('a summary is produced', !!summary, JSON.stringify(summary).slice(0, 80));
  check('by actually calling the model', seen.calls === 1, `${seen.calls} calls`);
  check('it is a message of its own', summary.role === 'summary');
  check('carrying the text', /fourteen turns/.test(summary.text));
  check('and saying how much it stands in for', summary.replaced === 6, String(summary.replaced));

  const saved = await store.listMessages(user.id, chat.id);
  check('it is written into the conversation', saved.some((m) => m.role === 'summary'));
  check(
    'the summariser gets no tools — it is a writing job',
    seen.tools?.length === 0,
    JSON.stringify(seen.tools),
  );

  // Nothing to fold is not a failure.
  const { stream: s2 } = scriptedProvider([{ text: 'nope' }]);
  const nothing = await compact({
    userId: user.id,
    chatId: chat.id,
    entry: { context: 100_000 },
    prefs: {},
    messages: [{ id: 'x', role: 'user', text: 'only one' }],
    stream: s2,
  });
  check('a short conversation folds to nothing, quietly', nothing === null);
}

section('approval gating by policy');
{
  const calls = [
    { id: '1', name: 'read_file', input: { path: 'a.txt' } },
    { id: '2', name: 'write_file', input: { path: 'a.txt' } },
    { id: '3', name: 'run_command', input: { command: 'rm -rf build' } },
  ];
  const ids = (policy) => needsApproval(calls, policy).map((c) => c.id).join(',');

  check('auto gates nothing', ids('auto') === '');
  check('readonly gates nothing (those tools were never offered)', ids('readonly') === '');
  check('guarded gates only the destructive one', ids('guarded') === '3', ids('guarded'));
  check('ask gates everything that changes anything', ids('ask') === '2,3', ids('ask'));
  check('plan gates nothing either — it is readonly with a brief', ids('plan') === '');
}

section('planning mode is offered the reading tools and nothing else');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const forPolicy = (policy) =>
    availableTools({ workerOnline: true, desktopOnline: false, policy }).map((t) => t.name);

  const plan = forPolicy('plan');
  check('nothing that writes is even advertised', !plan.some((n) => /write|edit|delete|move/.test(n)), plan.join(' '));
  check('it can still read files', plan.includes('read_file'));
  // The one tool the mode exists to produce output with. It is read-only, so it
  // survives the filter — but only by accident unless something checks.
  check('and still keep a plan in front of the user', plan.includes('update_plan'));
  check('same set as read-only', plan.join() === forPolicy('readonly').join());
  check('while guarded keeps the full set', forPolicy('guarded').length > plan.length);
}

// ── asking a model for more output than it has ──────────────────────
//
// Every adapter defaulted to 32000 and nothing ever passed anything else, so a
// request to `ai21/jamba-large-1.7` (4096) asked for eight times its published
// limit, and a request to `openai/gpt-4` asked for four times its entire
// 8191-token window. Forty-five of the models in the catalogue cap below 32000.
section('output budget follows the model');
{
  const { __testing } = await import('../server/providers/index.js');
  const { resolveModel } = await import('../server/providers/catalog.js');
  const { outputBudget } = __testing;

  const shared = (row) =>
    resolveModel('openrouter/x/y', { id: 'openrouter/x/y', provider: 'openrouter', model: 'x/y', ...row });

  check(
    'a published cap is respected rather than overshot',
    outputBudget(shared({ context: 256_000, max_output: 4096 })) === 4096,
    String(outputBudget(shared({ context: 256_000, max_output: 4096 }))),
  );
  check(
    'a model that publishes more than 32000 gets it',
    outputBudget(shared({ context: 1_000_000, max_output: 65_536 })) === 65_536,
  );

  // No published cap: derived from the window, because the two numbers are
  // unrelated and a constant gets it wrong in both directions.
  const gpt4 = shared({ context: 8191, max_output: null });
  check('an unpublished cap is derived from the window', gpt4.maxOutput === 4095, String(gpt4.maxOutput));
  check(
    'and never exceeds the window it shares with the prompt',
    outputBudget(gpt4) <= 8191 - 1024,
    String(outputBudget(gpt4)),
  );

  // Built-ins carry their own figure and must be untouched by any of this. Opus
  // says 64000 and was being cut to 32000, so long documents were truncated.
  check(
    'Claude Opus keeps its full 64000 rather than the old flat 32000',
    outputBudget(resolveModel('anthropic/claude-opus-5')) === 64_000,
  );
  check('a model with no context at all still gets a usable number', outputBudget({}) === 32_000);
}

// ── the compaction budget on a small window ─────────────────────────
//
// `measure` reserved a flat 32000 for the reply, so any model whose whole window
// was smaller got `max(1, 8191 - 32000)` — a budget of one token. Every
// conversation then read as 100% full from its first message, and auto-compaction
// (on by default) summarised the whole transcript on every single turn: an extra
// model call each time, spending tokens to save them.
section('a small window does not compact on every turn');
{
  const { measure, shouldCompact } = await import('../server/compact.js');
  const { resolveModel } = await import('../server/providers/catalog.js');
  const small = (context) =>
    resolveModel('openrouter/x/y', {
      id: 'openrouter/x/y', provider: 'openrouter', model: 'x/y', context, max_output: null,
    });

  for (const context of [4095, 8191, 16_385, 32_768]) {
    const opening = measure([{ role: 'user', text: 'hello' }], small(context));
    check(
      `a ${context}-token window leaves room to work in`,
      opening.budget > 1 && opening.ratio < 0.1,
      `budget ${opening.budget}, ratio ${opening.ratio}`,
    );
  }

  const filler = Array.from({ length: 12 }, (_, i) => ({ role: 'user', text: `turn ${i}` }));
  check('a fresh conversation on a small model is not folded', shouldCompact([...filler], small(8191)) === false);
  // And it still folds when it genuinely is full, or the mechanism is simply off.
  check(
    'but a genuinely full one still is',
    shouldCompact([...filler, { role: 'assistant', usage: { input: 4000 } }], small(8191)) === true,
  );
}

// ── what the catalogue costs to advertise ───────────────────────────
section('the tool catalogue is cut to fit a small window');
{
  const { availableTools } = await import('../server/tools/definitions.js');
  const base = { workerOnline: true, desktopOnline: true, policy: 'guarded' };
  const cost = (tools) =>
    JSON.stringify(tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))).length;

  // The windows here are chosen against the *share* the catalogue takes, which
  // is what decides the cut now — an absolute 32k used to mean "trim only", and
  // with a catalogue this size 32k is genuinely crowded, so it drops as well.
  // test/toolbudget.test.mjs pins the share rule itself.
  const roomy = availableTools({ ...base, context: 1_000_000 });
  const tight = availableTools({ ...base, context: 60_000 });
  const tiny = availableTools({ ...base, context: 8191 });

  check('a crowded window gets shorter descriptions', cost(tight) < cost(roomy), `${cost(tight)} vs ${cost(roomy)}`);
  check('a tiny one drops the secondary tools too', tiny.length < tight.length, `${tiny.length} vs ${tight.length}`);
  check(
    'but never the core loop',
    ['read_file', 'write_file', 'run_command', 'web_search', 'create_file', 'update_plan'].every((n) =>
      tiny.some((t) => t.name === n),
    ),
    tiny.map((t) => t.name).join(' '),
  );
  check('an unknown window is not treated as no room', cost(availableTools({ ...base })) === cost(roomy));

  // A connector tool whose service is not linked can only fail, and its schema
  // was paid for on every request by every account regardless.
  const none = availableTools({ ...base, connected: [] }).map((t) => t.name);
  check('an unlinked connector is not advertised', !none.includes('slack_post') && !none.includes('github'));
  const slack = availableTools({ ...base, connected: ['slack'] }).map((t) => t.name);
  check('a linked one is', slack.includes('slack_post') && !slack.includes('notion_search'));
  check(
    'omitting the list keeps them all, rather than guessing at none',
    availableTools({ ...base }).some((t) => t.name === 'github'),
  );
}

// ── the transcript is cached, not just the system prompt ────────────
section('Anthropic caches the part of the conversation that repeats');
{
  const { __testing } = await import('../server/providers/anthropic.js');
  const { toMessages, withCachePoint } = __testing;

  // The array a replayed assistant turn comes from is the one held in the
  // database. Writing a wire detail into it would persist it, and then send it
  // again next turn in the wrong place.
  const stored = [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't1', name: 'read_file', input: {} }];
  const wire = withCachePoint(
    toMessages([
      { role: 'user', text: 'one' },
      { role: 'assistant', text: 'a', raw: { anthropic: stored } },
      { role: 'tool', results: [{ toolCallId: 't1', name: 'read_file', content: 'body' }] },
      { role: 'user', text: 'newest' },
    ]),
  );
  const cached = (m) => (m.content || []).some((b) => b.cache_control);

  check('the reusable prefix carries a breakpoint', cached(wire[wire.length - 2]));
  check('the newest turn does not — it would never be read back', !cached(wire[wire.length - 1]));
  check('the stored transcript is left alone', !JSON.stringify(stored).includes('cache_control'));
  check(
    'a one-message conversation is a no-op, not a crash',
    withCachePoint(toMessages([{ role: 'user', text: 'hi' }])).length === 1,
  );
  check('and an empty one too', withCachePoint([]).length === 0);
}

// ── the counterparts that were missing ──────────────────────────────
//
// Each of these let the model do half a job and then stop: write a note it could
// never remove, schedule work it could never see or cancel, drive a browser with
// no Back button, set every field on a form except a dropdown.
section('every tool has its counterpart');
{
  const { TOOLS } = await import('../server/tools/definitions.js');
  const { CLOUD_IMPLEMENTATIONS } = await import('../server/tools/cloud.js');
  const { LOCAL_IMPLEMENTATIONS } = await import('../worker/tools.js');

  const declared = new Set(TOOLS.map((t) => t.name));
  const implemented = new Set([...Object.keys(CLOUD_IMPLEMENTATIONS), ...Object.keys(LOCAL_IMPLEMENTATIONS)]);

  for (const name of [
    'memory_delete', 'list_tasks', 'cancel_task',
    'browser_back', 'browser_forward', 'browser_select', 'browser_hover',
    'multi_edit',
  ]) {
    check(`${name} is declared and implemented`, declared.has(name) && implemented.has(name));
  }

  // The whole reason a tool can be advertised and then fail with "no
  // implementation" is that these two lists are maintained by hand.
  const orphanDeclared = [...declared].filter((n) => !implemented.has(n));
  const orphanImplemented = [...implemented].filter((n) => !declared.has(n));
  check('no tool is advertised without an implementation', orphanDeclared.length === 0, orphanDeclared.join(' '));
  check('and none is implemented without being declared', orphanImplemented.length === 0, orphanImplemented.join(' '));
}

// ── the plan panel ──────────────────────────────────────────────────
/**
 * The plan is the one piece of the interface the model draws directly, so what
 * it sends is normalised rather than trusted — and the *decision* to draw one at
 * all is half the feature. A checklist above a two-line answer is not a smaller
 * version of a good plan, it is noise the user has to read first.
 */
const { normalisePlan, PLAN_MIN_STEPS, CLOUD_IMPLEMENTATIONS } = await import(
  '../server/tools/cloud.js'
);
const planTitles = (steps) => steps.map((s) => `${s.title}:${s.status}`).join(' ');

section('the plan is normalised before anybody sees it');
{
  const clean = normalisePlan([
    { title: 'Read the corpus', status: 'done' },
    { title: 'Recompute co-occurrence', status: 'in_progress' },
    { title: 'Rebuild Figure 27', status: 'pending' },
  ]);
  check(
    'a well-formed plan passes through unchanged',
    planTitles(clean) ===
      'Read the corpus:done Recompute co-occurrence:in_progress Rebuild Figure 27:pending',
    planTitles(clean),
  );

  // Models mark three things started at once, and then the panel cannot answer
  // the only question it exists to answer: where are you now.
  const many = normalisePlan([
    { title: 'One', status: 'in_progress' },
    { title: 'Two', status: 'in_progress' },
    { title: 'Three', status: 'in_progress' },
  ]);
  check(
    'only the first in_progress survives',
    many.filter((s) => s.status === 'in_progress').length === 1,
    planTitles(many),
  );
  check('and the rest go back to pending, not away', many.length === 3, planTitles(many));

  const junk = normalisePlan([
    { title: '  Padded  ', status: 'nonsense' },
    { title: '', status: 'done' },
    null,
    { status: 'done' },
    { title: 'Kept', status: 'done' },
  ]);
  check('an unknown status falls back to pending', junk[0]?.status === 'pending', planTitles(junk));
  check('titles are trimmed', junk[0]?.title === 'Padded');
  check('untitled and malformed steps are dropped', junk.length === 2, planTitles(junk));
  check('a non-array is not a crash', normalisePlan(undefined).length === 0);
}

section('a job too short to plan draws nothing');
{
  check('the floor is at least two steps', PLAN_MIN_STEPS >= 2, String(PLAN_MIN_STEPS));

  // The agent loop's own condition, so this fails if the two ever drift apart.
  const drawn = (steps) => normalisePlan(steps).length >= PLAN_MIN_STEPS;
  check('one step is not a plan', !drawn([{ title: 'Do the thing', status: 'in_progress' }]));
  check('nor is an empty list', !drawn([]));
  check(
    'two steps are',
    drawn([
      { title: 'Read', status: 'done' },
      { title: 'Write', status: 'in_progress' },
    ]),
  );

  const short = await CLOUD_IMPLEMENTATIONS.update_plan({
    steps: [{ title: 'Answer the question', status: 'in_progress' }],
  });
  // Silently answering "Plan updated" would teach the model to keep sending a
  // plan nobody is drawing, and to describe a checklist the user cannot see.
  check('the model is told no plan was shown', /no plan was shown/i.test(short), short);
  check('and told to just answer instead', /answer directly/i.test(short), short);

  const real = await CLOUD_IMPLEMENTATIONS.update_plan({
    steps: [
      { title: 'Read the corpus', status: 'done' },
      { title: 'Rebuild Figure 27', status: 'in_progress' },
      { title: 'Verify the document', status: 'pending' },
    ],
  });
  check('a real plan reports its progress', /1\/3 done/.test(real), real);
  check('and names the step it is on', /Rebuild Figure 27/.test(real), real);
}

section('the model is told both when to plan and when not to');
{
  // Read as source rather than through the builder, which is not exported. The
  // point is that neither half of the rule can be deleted without a test going
  // red — the previous version said when to plan and never when to stop, which
  // is what made it plan for everything, or for nothing.
  const agentSrc = fs.readFileSync(new URL('../server/agent.js', import.meta.url), 'utf8');
  check('the prompt says when to plan', /\*\*Plan when/.test(agentSrc));
  check('and, just as explicitly, when not to', /\*\*Do not plan when/.test(agentSrc));
  check('with a countable threshold rather than an adjective', /three or more steps/.test(agentSrc));
  check('it asks for one in_progress at a time', /one step `in_progress`/.test(agentSrc));
  check('and for the plan to be revised when reality differs', /resend the list/i.test(agentSrc));

  // On a model under 40k only the first sentence of a description survives, so
  // the threshold has to sit inside it rather than trailing after.
  const toolSrc = fs.readFileSync(
    new URL('../server/tools/definitions.js', import.meta.url),
    'utf8',
  );
  const desc = toolSrc.match(/'Show the user a live checklist[^']*'/)?.[0] || '';
  const firstSentence = desc.match(/^'.*?\./)?.[0] || '';
  check('the tool description carries the threshold too', /three or more steps/.test(desc));
  check(
    'and carries it in the first sentence, the one that survives trimming',
    /three or more/.test(firstSentence),
    firstSentence,
  );
}

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

console.log(
  failures === 0
    ? '\n[32mAll agent checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
