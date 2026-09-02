/**
 * Projects: instructions that survive between conversations, and answers held
 * to the documents on the shelf.
 *
 * The failure this suite exists to prevent is the one the feature is for: an
 * assistant that has sources in front of it and answers from somewhere else.
 * That cannot be tested by asking a model — it needs a key, it costs money and
 * it is not deterministic — so what is checked here is everything that decides
 * whether it can: what text reaches the prompt, whether the rules are in it,
 * and whether one account's shelf can ever be read by another.
 *
 *   node test/projects.test.mjs
 */
import os from 'node:os';
import path from 'node:path';
import { removeTemp } from './lib/tmp.mjs';

process.env.ENCRYPTION_KEY ||= 'projects-test-encryption-key';
process.env.SESSION_SECRET ||= 'projects-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-projects-test-${process.pid}`);
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;
removeTemp(process.env.DATA_DIR);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
await initStore();

const PORT = 5206;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!pass) failures += 1;
};

function jar() {
  let cookie = '';
  return {
    async call(method, url, body) {
      const res = await fetch(`${base}${url}`, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0];
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        /* an HTML error page is a fine thing to assert on as text */
      }
      return { status: res.status, body: json, text };
    },
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

const alice = jar();
await alice.call('POST', '/api/register', {
  name: 'Alice',
  email: 'alice@projects.test',
  password: 'a-long-enough-password',
});

/* ── the shelf ─────────────────────────────────────────────────── */

section('a project is a name, instructions and sources');
let projectId;
{
  const bad = await alice.call('POST', '/api/projects', { name: '   ' });
  check('a project needs a name', bad.status === 400, `${bad.status}`);

  const made = await alice.call('POST', '/api/projects', { name: 'Salesforce exam' });
  projectId = made.body?.project?.id;
  check('creating one works', made.status === 201 && !!projectId, `${made.status}`);
  check('and it is grounded by default', made.body?.project?.grounded === true, 'the point of the feature');

  const listed = await alice.call('GET', '/api/projects');
  check('it appears on the shelf', listed.body?.projects?.length === 1);
  check('with a count of its sources', listed.body?.projects?.[0]?.file_count === 0);

  const saved = await alice.call('PATCH', `/api/projects/${projectId}`, {
    instructions: 'Answer in Vietnamese. Cite the question number.',
    grounded: true,
  });
  check('instructions save', /Vietnamese/.test(saved.body?.project?.instructions || ''));
}

section('what may go on the shelf');
{
  const text = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'notes.md',
    mime: 'text/markdown',
    data: b64('# Chapter one\n\nThe deadline is 14 March.\n'),
  });
  check('a text file is read', text.status === 201, `${text.status}`);
  check('and its length recorded', text.body?.file?.chars > 10, `${text.body?.file?.chars}`);

  const image = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'diagram.png',
    mime: 'image/png',
    data: b64('not really a png'),
  });
  // A picture cannot be quoted, and a source that is never consulted is worse
  // than no source at all — it looks like knowledge.
  check('an image is refused', image.status === 400, `${image.status}`);
  check('and says why', /quote/i.test(image.body?.error || ''), image.body?.error);

  const junk = await alice.call('POST', `/api/projects/${projectId}/files`, {
    name: 'archive.zip',
    mime: 'application/zip',
    data: b64('PK'),
  });
  check('and so is a kind nothing can read', junk.status === 400, junk.body?.error);
}

/* ── the part that decides whether answers are grounded ─────────── */

section('what actually reaches the prompt');
{
  const { selectSources, renderProject } = await import('../server/projects.js');

  const files = [
    { name: 'rules.md', text: 'The pass mark is 5.0. Late work loses one point per day.' },
    { name: 'syllabus.md', text: 'Week one covers objects. Week two covers SOQL.' },
  ];

  const small = selectSources(files, 'what is the pass mark');
  check('a small shelf is sent whole', small.whole && small.sources.length === 2);
  check('nothing is cut', small.sources[0].text === files[0].text);

  // Over the budget, only the passages that answer the question travel — and
  // the gaps are marked, because a model shown a jump cut without one reads
  // straight across it.
  const long = [
    { name: 'big.md', text: `${'filler about unrelated matters. '.repeat(400)}\n\nThe pass mark is 5.0.\n\n${'more filler. '.repeat(400)}` },
  ];
  const picked = selectSources(long, 'what is the pass mark', 800);
  check('a long shelf is searched instead', !picked.whole);
  check('and the answer is in what was picked', /pass mark is 5\.0/.test(picked.sources[0].text), picked.sources[0].text.slice(0, 80));
  check('with the cuts marked', picked.sources[0].text.includes('[…]'));
  check('and it respects the budget', picked.sources[0].text.length < 1400, `${picked.sources[0].text.length}`);

  const { briefing, passages } = renderProject({
    project: { name: 'Exam', instructions: 'Answer in Vietnamese.', grounded: true },
    names: files.map((f) => f.name),
    ...small,
  });
  check('the project is named', /# Project: Exam/.test(briefing));
  check('its instructions are carried', /Answer in Vietnamese\./.test(briefing));
  check('the sources are listed by name', /rules\.md, syllabus\.md/.test(briefing));
  check('the text itself is there', /pass mark is 5\.0/.test(passages));

  // The four rules that make grounding mean something.
  check('claims must name their file', /name the file it came from/.test(briefing));
  check('not covered is a correct answer', /do not cover/.test(briefing));
  check('gaps must not be filled from memory', /Do not fill gaps from general knowledge/.test(briefing));
  check('disagreement is reported, not resolved silently', /If two sources disagree/.test(briefing));

  /*
   * The split, which is the whole reason this returns two strings.
   *
   * The briefing is identical on every turn of a conversation; the passages are
   * chosen from the question being asked. They used to be one string in the
   * system prompt, which carries the cache breakpoint — so the cached prefix
   * changed every turn, and because caching is a prefix match over tools, then
   * system, then messages, it took the whole transcript's cache with it. Every
   * project conversation paid full price for its entire prefix, on every step.
   *
   * Pinning it here because it is invisible: nothing about the output looks
   * wrong when the passages leak back into the briefing, it just silently costs
   * several times more.
   */
  check('the question-selected text is NOT in the briefing', !/pass mark is 5\.0/.test(briefing));
  check('  which is what keeps the cached prefix identical between turns', !/### /.test(briefing));

  /*
   * Two different questions over the same shelf, including one short enough to
   * fit whole and one that has to be searched — which is the case that caught
   * the last invalidator. The "some sources are too long" note used to sit in
   * the briefing, so whether the shelf happened to fit changed the supposedly
   * stable prefix and no turn could ever be a cache hit.
   */
  const sameShelf = (question, budget) =>
    renderProject({
      project: { name: 'Exam', instructions: 'Answer in Vietnamese.', grounded: true },
      names: files.map((f) => f.name),
      ...selectSources(long, question, budget),
    }).briefing;

  check(
    'a different question produces the same briefing byte for byte',
    sameShelf('what is the pass mark', 800) === sameShelf('something else entirely', 800),
    'if this ever differs, prompt caching is dead for every project chat',
  );
  check(
    '  and so does one that fits the shelf whole',
    sameShelf('what is the pass mark', 800) === sameShelf('what is the pass mark', 500_000),
  );

  const loose = renderProject({
    project: { name: 'Exam', instructions: '', grounded: false },
    names: ['rules.md'],
    ...small,
  }).briefing;
  check('the unrestricted mode says so instead', /general knowledge as well/.test(loose));
  check('and still asks for filenames', /name the file/.test(loose));

  const empty = renderProject({
    project: { name: 'Exam', instructions: '', grounded: true },
    names: [],
    sources: [],
    whole: true,
    truncated: false,
  });
  check('a project with no sources admits it', /no sources yet/.test(empty.briefing), empty.briefing.slice(-90));
  check('  and has no passages to carry', empty.passages === '');
}

// ── the passages ride on the question, not on the system prompt ─────
section('project sources attach to the turn that selected them');
{
  const { withProjectSources } = await import('../server/agent.js');

  const transcript = [
    { id: 'm1', role: 'user', text: 'first question' },
    { id: 'm2', role: 'assistant', text: 'an answer' },
    { id: 'm3', role: 'user', text: 'what is the pass mark' },
  ];
  const out = withProjectSources(transcript, '### rules.md\nThe pass mark is 5.0');

  check('the sources land on the last user turn', /pass mark is 5\.0/.test(out[2].text));
  check('  along with what was actually asked', /what is the pass mark/.test(out[2].text));
  check('earlier turns are untouched', out[0].text === 'first question' && out[1].text === 'an answer');
  check(
    'and the stored message is not mutated',
    transcript[2].text === 'what is the pass mark',
    'this is a wire detail — writing it into the transcript would resend it next turn with stale passages',
  );
  check('nothing to attach means nothing changes', withProjectSources(transcript, '') === transcript);

  // A turn that ends in a tool result still has a user message further back, and
  // that is where the question lives.
  const midRun = [
    { id: 'm1', role: 'user', text: 'the question' },
    { id: 'm2', role: 'assistant', text: '', toolCalls: [{ id: 't', name: 'x', input: {} }] },
    { id: 'm3', role: 'tool', results: [{ toolCallId: 't', name: 'x', content: 'ok' }] },
  ];
  const resumed = withProjectSources(midRun, '### rules.md\nbody');
  check('mid-run, it still finds the question', /body/.test(resumed[0].text));
  check('  and leaves the tool result alone', resumed[2] === midRun[2]);
}

section('a conversation inherits its project');
{
  const made = await alice.call('POST', '/api/chats', { projectId });
  const chatId = made.body?.chat?.id;
  check('a chat can be filed under one', made.status === 201 && !!chatId);

  const opened = await alice.call('GET', `/api/chats/${chatId}`);
  check('and says so when opened', opened.body?.project?.id === projectId);
  check('with its source count, for the header', opened.body?.project?.files === 1, `${opened.body?.project?.files}`);

  // Blank until somebody speaks: the same rule as the sidebar, so a project
  // does not accumulate a list of conversations that never happened.
  const empty = await alice.call('GET', `/api/projects/${projectId}`);
  check('a conversation nobody spoke in is not listed', empty.body?.chats?.length === 0, `${empty.body?.chats?.length}`);

  await alice.call('POST', `/api/chats/${chatId}/messages`, { text: 'first question' });
  const listed = await alice.call('GET', `/api/projects/${projectId}`);
  check('the project lists its conversations', listed.body?.chats?.length === 1, `${listed.body?.chats?.length}`);

  const nonsense = await alice.call('POST', '/api/chats', { projectId: 'not-a-real-project' });
  check('an unknown project is refused', nonsense.status === 404, `${nonsense.status}`);

  // The conversations are a record of work; the folder going away must not take
  // them with it.
  const throwaway = await alice.call('POST', '/api/projects', { name: 'Temporary' });
  const inside = await alice.call('POST', '/api/chats', { projectId: throwaway.body.project.id });
  await alice.call('DELETE', `/api/projects/${throwaway.body.project.id}`);
  const survivor = await alice.call('GET', `/api/chats/${inside.body.chat.id}`);
  check('deleting a project keeps its conversations', survivor.status === 200);
  check('they simply stop belonging to one', survivor.body?.project === null);
}

/* ── pinning and archiving ─────────────────────────────────────── */

section('a shelf can be ordered and thinned out');
{
  // Three, made in order, so "last updated" has something to say.
  const names = ['Alpha', 'Beta', 'Gamma'];
  const made = [];
  for (const name of names) {
    const res = await alice.call('POST', '/api/projects', { name });
    made.push(res.body.project.id);
  }

  const fresh = await alice.call('GET', '/api/projects');
  check('a new project starts unpinned', fresh.body.projects.every((p) => !p.pinned));
  check('and un-archived', fresh.body.projects.every((p) => !p.archived_at));

  // Alpha was the oldest of the three, so a pin has to beat recency for this
  // to prove anything.
  const pinned = await alice.call('PATCH', `/api/projects/${made[0]}`, { pinned: true });
  check('a project can be pinned', pinned.body?.project?.pinned === true);

  const ordered = await alice.call('GET', '/api/projects');
  check('and it comes first', ordered.body.projects[0].id === made[0], ordered.body.projects[0].name);

  const archived = await alice.call('PATCH', `/api/projects/${made[1]}`, { archived: true });
  check('a project can be archived', !!archived.body?.project?.archived_at);

  const shelf = await alice.call('GET', '/api/projects');
  check('and leaves the shelf', !shelf.body.projects.some((p) => p.id === made[1]));

  const box = await alice.call('GET', '/api/projects?archived=1');
  check('for the archived one', box.body.projects.length === 1, `${box.body.projects.length}`);
  check('which is the one archived', box.body.projects[0]?.id === made[1]);

  // Archiving must not be a quiet delete: everything on it is still there.
  const intact = await alice.call('GET', `/api/projects/${made[1]}`);
  check('an archived project still opens', intact.status === 200, `${intact.status}`);

  const restored = await alice.call('PATCH', `/api/projects/${made[1]}`, { archived: false });
  check('and it can come back', restored.body?.project?.archived_at === null, `${restored.body?.project?.archived_at}`);
  const back = await alice.call('GET', '/api/projects');
  check('to the shelf it left', back.body.projects.some((p) => p.id === made[1]));

  // A patch that says nothing about pinning must not quietly unpin. The old
  // COALESCE-everything shape got this right by accident; the CASE for
  // `archived_at` is where it would have gone wrong.
  await alice.call('PATCH', `/api/projects/${made[0]}`, { name: 'Alpha renamed' });
  const still = await alice.call('GET', '/api/projects');
  check('renaming leaves a pin alone', still.body.projects[0].id === made[0], still.body.projects[0].name);
  check('and leaves the archive flag alone', !still.body.projects[0].archived_at);

  for (const id of made) await alice.call('DELETE', `/api/projects/${id}`);
}

/* ── the boundary ──────────────────────────────────────────────── */

section('one account cannot read another account\'s shelf');
{
  const bob = jar();
  await bob.call('POST', '/api/register', {
    name: 'Bob',
    email: 'bob@projects.test',
    password: 'another-long-password',
  });

  const seen = await bob.call('GET', `/api/projects/${projectId}`);
  check('not by id', seen.status === 404, `${seen.status}`);

  const listed = await bob.call('GET', '/api/projects');
  check('not in a listing', listed.body?.projects?.length === 0, `${listed.body?.projects?.length}`);

  const written = await bob.call('POST', `/api/projects/${projectId}/files`, {
    name: 'sneaky.md',
    mime: 'text/markdown',
    data: b64('hello'),
  });
  check('and nothing can be put on it', written.status === 404, `${written.status}`);

  const edited = await bob.call('PATCH', `/api/projects/${projectId}`, { name: 'mine now' });
  check('nor renamed', edited.status === 404, `${edited.status}`);

  const filed = await bob.call('POST', '/api/chats', { projectId });
  check('nor filed against', filed.status === 404, `${filed.status}`);

  const anonymous = await fetch(`${base}/api/projects`);
  check('and signed out reaches nothing at all', anonymous.status === 401, `${anonymous.status}`);
}

removeTemp(process.env.DATA_DIR);
console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll project checks passed.\x1b[0m\n',
);
server.close();
process.exit(failures ? 1 : 0);
