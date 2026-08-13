/**
 * The workspace, from the interface.
 *
 * The assistant has been able to read, write and edit files on the machine
 * since the beginning; these routes give the person sitting in front of it the
 * same reach. That makes them the most dangerous surface in the application, so
 * most of what follows is about what they refuse: paths that climb out of the
 * workspace, another account's machine, the workspace itself.
 *
 * A locally-run server executes worker tools in-process for the admin account,
 * which is what lets this suite drive the real filesystem code rather than a
 * stand-in.
 *
 *   node test/workspace.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.ENCRYPTION_KEY ||= 'workspace-test-encryption-key';
process.env.SESSION_SECRET ||= 'workspace-test-session-secret';
process.env.DATA_DIR = path.join(os.tmpdir(), `ai-remote-workspace-test-${process.pid}`);
// The folder the tools are confined to, and the one this suite works in.
process.env.WORKSPACE = path.join(os.tmpdir(), `ai-remote-workspace-${process.pid}`);
delete process.env.FILE_ACCESS;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;
delete process.env.VERCEL;

fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
fs.rmSync(process.env.WORKSPACE, { recursive: true, force: true });
fs.mkdirSync(process.env.WORKSPACE, { recursive: true });
fs.mkdirSync(path.join(process.env.WORKSPACE, 'src'), { recursive: true });
fs.writeFileSync(path.join(process.env.WORKSPACE, 'readme.md'), '# Xin chào\n\nGhi chú.\n');
fs.writeFileSync(path.join(process.env.WORKSPACE, 'src', 'app.js'), "console.log('hello');\n");
fs.writeFileSync(path.join(process.env.WORKSPACE, 'photo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));

// A secret outside the workspace, which nothing here may reach.
const OUTSIDE = path.join(os.tmpdir(), `ai-remote-outside-${process.pid}.txt`);
fs.writeFileSync(OUTSIDE, 'this must never be readable through the app');

const { setWorkspace } = await import('../worker/paths.js');
setWorkspace(process.env.WORKSPACE);

const { createApp } = await import('../server/app.js');
const { initStore } = await import('../server/store/index.js');
await initStore();

const PORT = 5212;
const server = createApp().listen(PORT);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${PORT}`;

let failures = 0;
const section = (name) => console.log(`\n[1m${name}[0m`);
const check = (label, pass, detail = '') => {
  console.log(`  ${pass ? '[32m✓[0m' : '[31m✗ FAIL[0m'}  ${label}${detail ? ` — ${detail}` : ''}`);
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
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 120) };
      }
      return { status: res.status, json };
    },
  };
}

const owner = jar();
const other = jar();
const anon = jar();

// The first account is the administrator, and on a local run it is the one
// whose tools execute in-process.
await owner.call('POST', '/api/register', {
  email: 'owner@example.com',
  password: 'a-long-enough-password',
  name: 'Owner',
});
await other.call('POST', '/api/register', {
  email: 'other@example.com',
  password: 'another-long-password',
  name: 'Other',
});

const q = (path) => encodeURIComponent(path);

// ── browsing ────────────────────────────────────────────────────────
section('browsing the folder');
{
  const root = await owner.call('GET', '/api/workspace?path=.');
  check('the workspace lists', root.status === 200, JSON.stringify(root.json).slice(0, 90));
  check('it says where it is', !!root.json?.workspace, root.json?.workspace);

  const names = (root.json?.entries || []).map((e) => e.name);
  check('the files are there', names.includes('readme.md') && names.includes('app.js') === false, names.join(', '));
  check('and the folder', names.includes('src'));
  check(
    'folders come first, the way every file manager orders them',
    root.json.entries[0].dir === true,
    root.json.entries.map((e) => `${e.name}${e.dir ? '/' : ''}`).join(' '),
  );

  const file = root.json.entries.find((e) => e.name === 'readme.md');
  check('a file carries its size', file.size > 0, String(file.size));
  check('and when it changed', typeof file.modified === 'number');

  const inner = await owner.call('GET', `/api/workspace?path=${q('src')}`);
  check('a subfolder opens', inner.status === 200 && inner.json.path === 'src', inner.json?.path);
  check('with what is in it', inner.json.entries[0]?.name === 'app.js', JSON.stringify(inner.json.entries));

  const missing = await owner.call('GET', `/api/workspace?path=${q('nope')}`);
  check('a folder that is not there says so', missing.status === 400, `got ${missing.status}`);
}

// ── reading ─────────────────────────────────────────────────────────
section('opening a file');
{
  const file = await owner.call('GET', `/api/workspace/file?path=${q('readme.md')}`);
  check('it reads', file.status === 200, JSON.stringify(file.json).slice(0, 80));
  check('with its contents, in UTF-8', file.json?.content?.includes('Xin chào'), file.json?.content?.slice(0, 20));
  check('and its size', file.json?.bytes > 0);

  const binary = await owner.call('GET', `/api/workspace/file?path=${q('photo.bin')}`);
  check('a binary file is refused rather than mangled', binary.status === 400, `got ${binary.status}`);
  check('and says why', /binary/.test(binary.json?.error || ''), binary.json?.error);

  const folder = await owner.call('GET', `/api/workspace/file?path=${q('src')}`);
  check('a folder is not a file', folder.status === 400, `got ${folder.status}`);
}

// ── writing ─────────────────────────────────────────────────────────
section('saving, and making a new one');
{
  const saved = await owner.call('PUT', '/api/workspace/file', {
    path: 'readme.md',
    content: '# Đã sửa\n\nNội dung mới.\n',
  });
  check('an edit saves', saved.status === 200, JSON.stringify(saved.json).slice(0, 80));
  check(
    'and it is really on disk',
    fs.readFileSync(path.join(process.env.WORKSPACE, 'readme.md'), 'utf8').includes('Đã sửa'),
    'the file itself, not a copy',
  );

  const made = await owner.call('PUT', '/api/workspace/file', {
    path: 'notes/today.md',
    content: 'một dòng',
  });
  check('a new file in a new folder is created', made.status === 200, JSON.stringify(made.json).slice(0, 80));
  check(
    'parents and all',
    fs.existsSync(path.join(process.env.WORKSPACE, 'notes', 'today.md')),
    'write_file makes the folders on the way',
  );

  const nameless = await owner.call('PUT', '/api/workspace/file', { content: 'x' });
  check('a save with no path is refused', nameless.status === 400, `got ${nameless.status}`);
}

// ── deleting ────────────────────────────────────────────────────────
section('deleting');
{
  const gone = await owner.call('DELETE', `/api/workspace/file?path=${q('notes/today.md')}`);
  check('a file deletes', gone.status === 200, JSON.stringify(gone.json).slice(0, 80));
  check('and is gone from disk', !fs.existsSync(path.join(process.env.WORKSPACE, 'notes', 'today.md')));

  fs.writeFileSync(path.join(process.env.WORKSPACE, 'notes', 'keep.md'), 'still here');
  const full = await owner.call('DELETE', `/api/workspace/file?path=${q('notes')}`);
  check('a folder with something in it is not deleted on a guess', full.status === 400, `got ${full.status}`);
  check('and says what to pass', /recursive/.test(full.json?.error || ''), full.json?.error);

  const forced = await owner.call('DELETE', `/api/workspace/file?path=${q('notes')}&recursive=1`);
  check('asked properly, it goes', forced.status === 200, JSON.stringify(forced.json).slice(0, 80));
  check('with everything under it', !fs.existsSync(path.join(process.env.WORKSPACE, 'notes')));

  const root = await owner.call('DELETE', `/api/workspace/file?path=${q('.')}&recursive=1`);
  check('the workspace itself cannot be deleted', root.status === 400, `got ${root.status}`);
  check('because everything else resolves against it', /workspace itself/.test(root.json?.error || ''), root.json?.error);
  check('and it is still there', fs.existsSync(process.env.WORKSPACE));

  const missing = await owner.call('DELETE', `/api/workspace/file?path=${q('never-existed.txt')}`);
  check('deleting what is not there fails cleanly', missing.status === 400, `got ${missing.status}`);
}

section('renaming, and moving');
{
  const renamed = await owner.call('POST', '/api/workspace/move', { from: 'readme.md', to: 'README.md' });
  check('a file renames', renamed.status === 200, JSON.stringify(renamed.json).slice(0, 80));
  // Read from the directory listing, not with `existsSync`: Windows and macOS
  // are case-insensitive, so the old spelling still "exists" — as the very file
  // that was just renamed. Which is also why a case-only rename has to be
  // allowed at all, and is the case this checks.
  const listing = fs.readdirSync(process.env.WORKSPACE);
  check('under the new spelling', listing.includes('README.md'), listing.join(', '));
  check('and not the old one', !listing.includes('readme.md'), listing.join(', '));

  const moved = await owner.call('POST', '/api/workspace/move', { from: 'README.md', to: 'docs/README.md' });
  check('and moves into a folder that did not exist', moved.status === 200, JSON.stringify(moved.json).slice(0, 80));
  check('arriving there', fs.existsSync(path.join(process.env.WORKSPACE, 'docs', 'README.md')));

  fs.writeFileSync(path.join(process.env.WORKSPACE, 'taken.md'), 'do not lose me');
  const clash = await owner.call('POST', '/api/workspace/move', { from: 'docs/README.md', to: 'taken.md' });
  check('it will not overwrite by default', clash.status === 400, `got ${clash.status}`);
  check('and says how to mean it', /overwrite/.test(clash.json?.error || ''), clash.json?.error);
  check(
    'so the file that was there is still there',
    fs.readFileSync(path.join(process.env.WORKSPACE, 'taken.md'), 'utf8') === 'do not lose me',
  );

  const forced = await owner.call('POST', '/api/workspace/move', {
    from: 'docs/README.md',
    to: 'taken.md',
    overwrite: true,
  });
  check('asked properly, it replaces it', forced.status === 200, JSON.stringify(forced.json).slice(0, 60));

  const swallow = await owner.call('POST', '/api/workspace/move', { from: 'docs', to: 'docs/inner' });
  check('a folder cannot be moved inside itself', swallow.status === 400, `got ${swallow.status}`);
  check('because it would consume itself', /consume/.test(swallow.json?.error || ''), swallow.json?.error);

  const escape = await owner.call('POST', '/api/workspace/move', { from: 'taken.md', to: '../escaped.md' });
  check('and nothing can be moved out of the workspace', escape.status === 400, `got ${escape.status}`);
  check('leaving nothing behind outside', !fs.existsSync(path.join(os.tmpdir(), 'escaped.md')));
}

section('searching across the files');
{
  fs.writeFileSync(path.join(process.env.WORKSPACE, 'src', 'one.js'), "const greeting = 'xin chào';\nconsole.log(greeting);\n");
  fs.writeFileSync(path.join(process.env.WORKSPACE, 'src', 'two.js'), '// nothing to find here\n');
  fs.writeFileSync(path.join(process.env.WORKSPACE, 'notes.txt'), 'xin chào lần nữa\n');

  const found = await owner.call('GET', `/api/workspace/search?q=${q('xin chào')}&path=.`);
  check('a search answers', found.status === 200, JSON.stringify(found.json).slice(0, 80));
  check('finding every file it is in', found.json?.files?.length === 2, JSON.stringify(found.json?.files?.map((f) => f.path)));
  check('with the line number', found.json.files[0].hits[0].line > 0, String(found.json.files[0].hits[0].line));
  check('and the line itself', /xin chào/.test(found.json.files[0].hits[0].text), found.json.files[0].hits[0].text);
  check('it counts what it read', found.json.scanned >= 3, String(found.json.scanned));

  const scoped = await owner.call('GET', `/api/workspace/search?q=${q('xin chào')}&path=${q('src')}`);
  check('and searching a folder stays in it', scoped.json?.files?.length === 1, JSON.stringify(scoped.json?.files?.map((f) => f.path)));

  const literal = await owner.call('GET', `/api/workspace/search?q=${q('greeting)')}&path=.`);
  check(
    'the query is text, not a pattern',
    literal.json?.files?.length === 1,
    'somebody typing a bracket means a bracket, not a syntax error',
  );

  const nothing = await owner.call('GET', `/api/workspace/search?q=${q('zzz-not-here-zzz')}`);
  check('finding nothing is an answer', nothing.status === 200 && nothing.json.files.length === 0);

  const outside = await owner.call('GET', `/api/workspace/search?q=${q('never')}&path=${q('../..')}`);
  check('and it cannot be pointed out of the workspace', outside.status >= 400, `got ${outside.status}`);

  check('searching needs a session', (await anon.call('GET', '/api/workspace/search?q=x')).status === 401);
  check('as does moving', (await anon.call('POST', '/api/workspace/move', { from: 'a', to: 'b' })).status === 401);
}

// ── the part that matters ───────────────────────────────────────────
section('nothing reaches outside the workspace');
{
  for (const attempt of ['../../etc/passwd', '..', '../', `../${path.basename(OUTSIDE)}`, 'src/../../secret']) {
    const listed = await owner.call('GET', `/api/workspace?path=${q(attempt)}`);
    const read = await owner.call('GET', `/api/workspace/file?path=${q(attempt)}`);
    const wrote = await owner.call('PUT', '/api/workspace/file', { path: attempt, content: 'x' });
    check(
      `"${attempt}" is refused, three ways`,
      listed.status >= 400 && read.status >= 400 && wrote.status >= 400,
      `${listed.status}/${read.status}/${wrote.status}`,
    );
  }

  check(
    'the file outside is untouched',
    fs.readFileSync(OUTSIDE, 'utf8') === 'this must never be readable through the app',
  );

  // An absolute path is the same attempt, spelled differently.
  const absolute = await owner.call('GET', `/api/workspace/file?path=${q(OUTSIDE)}`);
  check('an absolute path outside is refused too', absolute.status >= 400, `got ${absolute.status}`);
}

section('and nothing reaches another account');
{
  const theirs = await other.call('GET', '/api/workspace?path=.');
  check(
    'a second account has no computer of its own here',
    theirs.status >= 400,
    `got ${theirs.status}: ${theirs.json?.error?.slice(0, 60)}`,
  );
  check(
    'and is told to connect one rather than shown somebody else\'s',
    /no computer is connected/i.test(theirs.json?.error || ''),
    theirs.json?.error?.slice(0, 80),
  );

  for (const url of ['/api/workspace?path=.', '/api/workspace/file?path=readme.md']) {
    check(`${url} needs a session`, (await anon.call('GET', url)).status === 401);
  }
  check('as does saving', (await anon.call('PUT', '/api/workspace/file', { path: 'x', content: 'y' })).status === 401);
  check('and deleting', (await anon.call('DELETE', '/api/workspace/file?path=x')).status === 401);
}

section('the model is not offered the interface\'s tools');
{
  const { availableTools, TOOLS_BY_NAME } = await import('../server/tools/definitions.js');
  const offered = availableTools({ workerOnline: true, desktopOnline: true, policy: 'auto' }).map((t) => t.name);

  check('fs_browse exists', !!TOOLS_BY_NAME.fs_browse);
  check('but is never offered', !offered.includes('fs_browse'), 'the model has list_dir, which is written to be read');
  check('nor fs_read_text', !offered.includes('fs_read_text'));
  check('delete_file is offered, because it is a real ability', offered.includes('delete_file'));

  const { assessRisk, riskReason } = await import('../server/tools/definitions.js');
  check(
    'and it always stops for a yes',
    assessRisk('delete_file', { path: 'notes.txt' }) === 'sensitive',
    'the one thing that cannot be undone',
  );
  check('with a reason that says so', /no undo/i.test(riskReason('delete_file', { path: 'notes.txt' })), riskReason('delete_file', { path: 'notes.txt' }));
}

server.close();
await new Promise((r) => server.once('close', r));
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
fs.rmSync(process.env.WORKSPACE, { recursive: true, force: true });
fs.rmSync(OUTSIDE, { force: true });

console.log(
  failures === 0
    ? '\n[32mAll workspace checks passed.[0m\n'
    : `\n[31m${failures} check(s) failed.[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
