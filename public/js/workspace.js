import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { toast } from './render.js';

/**
 * The folder on the machine, from here.
 *
 * The assistant has been able to read, write and edit files in the workspace
 * since the beginning; the person sitting in front of it could only ask for it
 * in prose and wait a turn. This is the same set of operations, reached
 * directly — and reached through the *same worker tools*, so the workspace
 * confinement, the symlink resolution and the per-account queue are inherited
 * rather than reimplemented. There is no second road to somebody's disk.
 *
 * Deliberately a file browser and not an IDE. Open a file, change it, save it,
 * make one, delete one. Anything past that — moving, renaming, searching across
 * files — is something the assistant already does better, and building a worse
 * version of it here would be furniture.
 */

const $ = (id) => document.getElementById(id);

const humanSize = (bytes) =>
  bytes == null
    ? ''
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : bytes >= 1024
        ? `${Math.round(bytes / 1024)} KB`
        : `${bytes} B`;

const ago = (ms) => {
  if (!ms) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
};

/** Two presses to delete, and the second one has to be deliberate. */
function armDelete(button, run) {
  let ready = false;
  const original = button.textContent;
  const reset = () => {
    ready = false;
    button.textContent = original;
    button.classList.remove('is-armed');
  };

  button.addEventListener('click', async (event) => {
    event.stopPropagation();
    if (!ready) {
      ready = true;
      button.textContent = t('ws.deleteConfirm');
      button.classList.add('is-armed');
      setTimeout(reset, 5000);
      return;
    }
    reset();
    await run();
  });
}

export function createWorkspace() {
  const dialog = $('workspace');
  const crumbs = $('workspace-crumbs');
  const body = $('workspace-body');
  const where = $('workspace-where');

  /** The folder being shown, workspace-relative. `.` is the root. */
  let at = '.';
  /** The file open in the editor, or null while browsing. */
  let editing = null;

  const parentOf = (path) => {
    const parts = path.split('/').filter((p) => p && p !== '.');
    parts.pop();
    return parts.length ? parts.join('/') : '.';
  };

  const join = (base, name) => (base === '.' ? name : `${base}/${name}`);

  /* ── the folder ───────────────────────────────────────────────── */

  function renderCrumbs(listing) {
    const parts = at === '.' ? [] : at.split('/').filter(Boolean);
    const trail = [{ label: 'workspace', path: '.' }];
    parts.forEach((part, i) => trail.push({ label: part, path: parts.slice(0, i + 1).join('/') }));

    crumbs.hidden = false;
    crumbs.innerHTML =
      trail
        .map((crumb, i) =>
          i === trail.length - 1 && !editing
            ? `<span class="crumbs__here">${escapeHtml(crumb.label)}</span>`
            : `<button class="crumbs__step" type="button" data-go="${escapeHtml(crumb.path)}">${escapeHtml(crumb.label)}</button>`,
        )
        .join('<span class="crumbs__sep">/</span>') +
      (editing ? `<span class="crumbs__sep">/</span><span class="crumbs__here">${escapeHtml(editing.name)}</span>` : '');

    for (const button of crumbs.querySelectorAll('[data-go]')) {
      button.addEventListener('click', () => open(button.dataset.go));
    }

    if (listing) where.textContent = listing.workspace || '';
  }

  function renderListing(listing) {
    const rows = [];

    if (at !== '.') {
      rows.push(`
        <button class="entry entry--up" type="button" data-open-dir="${escapeHtml(parentOf(at))}">
          <span class="entry__icon">↰</span>
          <span class="entry__name">..</span>
        </button>`);
    }

    for (const entry of listing.entries) {
      const path = join(listing.path, entry.name);
      rows.push(`
        <div class="entry${entry.dir ? ' entry--dir' : ''}">
          <button class="entry__main" type="button"
                  ${entry.dir ? `data-open-dir="${escapeHtml(path)}"` : `data-open-file="${escapeHtml(path)}"`}>
            <span class="entry__icon">${entry.dir ? '📁' : fileGlyph(entry.name)}</span>
            <span class="entry__name">${escapeHtml(entry.name)}${entry.link ? ' <span class="entry__link">link</span>' : ''}</span>
            <span class="entry__meta">${escapeHtml(humanSize(entry.size))}</span>
            <span class="entry__when">${escapeHtml(ago(entry.modified))}</span>
          </button>
          <button class="entry__act" type="button" data-rename="${escapeHtml(path)}"
                  title="${escapeHtml(t('ws.renameTitle'))}" aria-label="${escapeHtml(t('ws.renameAria').replace('{name}', entry.name))}">↳</button>
          <button class="entry__drop" type="button" data-delete="${escapeHtml(path)}"
                  data-dir="${entry.dir ? '1' : ''}" aria-label="${escapeHtml(t('ws.deleteAria').replace('{name}', entry.name))}">✕</button>
        </div>`);
    }

    body.innerHTML = rows.length
      ? `<div class="entries">${rows.join('')}</div>`
      : '<p class="hint">This folder is empty.</p>';

    for (const button of body.querySelectorAll('[data-open-dir]')) {
      button.addEventListener('click', () => open(button.dataset.openDir));
    }
    for (const button of body.querySelectorAll('[data-open-file]')) {
      button.addEventListener('click', () => openFile(button.dataset.openFile));
    }
    /**
     * Rename and move are one control, because they are one operation.
     *
     * The box is pre-filled with the path as it stands, so changing the last
     * segment renames and changing anything before it moves. Two buttons for
     * that would be two ways to describe the same `rename` call.
     */
    for (const button of body.querySelectorAll('[data-rename]')) {
      button.addEventListener('click', async (event) => {
        event.stopPropagation();
        const from = button.dataset.rename;
        const to = window.prompt(t('ws.renamePrompt'), from);
        if (!to || to === from) return;
        try {
          const { message } = await api.moveWorkspaceFile(from, to);
          toast(message || t('ws.moved'));
          await open(at);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    for (const button of body.querySelectorAll('[data-delete]')) {
      armDelete(button, async () => {
        try {
          const { message } = await api.deleteWorkspaceFile(button.dataset.delete, !!button.dataset.dir);
          toast(message || t('ws.deleted'));
          await open(at);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  }

  /** A glyph for the kind of file, so a listing reads at a glance. */
  const fileGlyph = (name) => {
    const ext = name.split('.').pop().toLowerCase();
    if (/^(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|cs|c|h|cpp|php|sh|ps1|sql)$/.test(ext)) return '⟨⟩';
    if (/^(json|ya?ml|toml|ini|env|xml)$/.test(ext)) return '⚙';
    if (/^(md|markdown|txt|log)$/.test(ext)) return '≡';
    if (/^(png|jpe?g|gif|webp|svg|ico)$/.test(ext)) return '▣';
    if (/^(docx|xlsx|pptx|pdf)$/.test(ext)) return '▤';
    return '·';
  };

  /* ── one file ─────────────────────────────────────────────────── */

  function renderEditor() {
    body.innerHTML = `
      <div class="editor">
        <textarea class="editor__box" id="workspace-editor" spellcheck="false"></textarea>
        <div class="editor__bar">
          <span class="editor__hint" id="workspace-editor-hint"></span>
          <button class="btn btn--ghost editor__save" id="workspace-back" type="button">Back</button>
          <button class="btn btn--primary editor__save" id="workspace-save" type="button">Save</button>
        </div>
      </div>`;

    const box = $('workspace-editor');
    // Assigned rather than interpolated: the file is somebody's source, and it
    // must reach the box as text and not as markup, whatever is in it.
    box.value = editing.content;
    $('workspace-editor-hint').textContent = `${editing.path} · ${humanSize(editing.bytes)}`;

    box.addEventListener('input', () => {
      const changed = box.value !== editing.content;
      $('workspace-editor-hint').textContent = `${editing.path} · ${humanSize(editing.bytes)}${
        changed ? ' · unsaved' : ''
      }`;
    });

    // Tab inserts a tab. Losing your place in a file because the browser moved
    // focus to the next button is not an editor.
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const { selectionStart: from, selectionEnd: to } = box;
        box.setRangeText('  ', from, to, 'end');
      }
      if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        save();
      }
    });

    $('workspace-back').addEventListener('click', () => {
      if (box.value !== editing.content && !window.confirm(t('ws.leaveUnsaved'))) return;
      editing = null;
      open(at);
    });
    $('workspace-save').addEventListener('click', save);
    box.focus();
  }

  async function save() {
    const box = $('workspace-editor');
    const button = $('workspace-save');
    if (!box || !editing) return;

    button.disabled = true;
    button.textContent = t('ws.saving');
    try {
      const { message } = await api.saveWorkspaceFile(editing.path, box.value);
      editing.content = box.value;
      editing.bytes = new Blob([box.value]).size;
      $('workspace-editor-hint').textContent = `${editing.path} · ${humanSize(editing.bytes)}`;
      toast(message || t('ws.saved'));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Save';
    }
  }

  async function openFile(path) {
    body.innerHTML = '<div class="viewer__loading"><span class="spinner"></span> Reading…</div>';
    try {
      const file = await api.workspaceFile(path);
      editing = { ...file, name: path.split('/').pop() };
      renderCrumbs(null);
      renderEditor();
    } catch (err) {
      toast(err.message, 'error');
      await open(at);
    }
  }

  /* ── the way in ───────────────────────────────────────────────── */

  async function open(path = '.') {
    editing = null;
    body.innerHTML = '<div class="viewer__loading"><span class="spinner"></span> Reading the folder…</div>';
    if (!dialog.open) dialog.showModal();

    try {
      const listing = await api.workspace(path);
      at = listing.path;
      renderCrumbs(listing);
      renderListing(listing);
    } catch (err) {
      crumbs.hidden = true;
      // The commonest reason by far, and the one with something to do about it.
      const offline = /no computer is connected/i.test(err.message);
      body.innerHTML = `<p class="hint">${escapeHtml(err.message)}${
        offline ? '<br><br>Start the worker on the machine you want to work on — Settings → Computers.' : ''
      }</p>`;
    }
  }

  /* ── searching across the files ───────────────────────────────── */

  /**
   * A plain-text search, grouped by the file each hit is in.
   *
   * Plain text and not a pattern: somebody typing `a.b` into a search box means
   * those three characters. `grep` with a real regular expression is one line
   * away in the chat, and the assistant is better at reading its output than
   * this would be at rendering it.
   */
  async function runSearch(query) {
    editing = null;
    crumbs.hidden = false;
    crumbs.innerHTML =
      `<button class="crumbs__step" type="button" data-go="${escapeHtml(at)}">← back to ${escapeHtml(at)}</button>` +
      `<span class="crumbs__sep">/</span><span class="crumbs__here">"${escapeHtml(query)}"</span>`;
    for (const button of crumbs.querySelectorAll('[data-go]')) {
      button.addEventListener('click', () => open(button.dataset.go));
    }

    body.innerHTML = '<div class="viewer__loading"><span class="spinner"></span> Searching…</div>';

    let found;
    try {
      found = await api.searchWorkspace(query, at);
    } catch (err) {
      body.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
      return;
    }

    if (!found.files.length) {
      body.innerHTML = `<p class="hint">Nothing in ${escapeHtml(at)} contains “${escapeHtml(query)}”. ${found.scanned} files read.</p>`;
      return;
    }

    body.innerHTML =
      `<p class="hint hits__count">${found.matches} match${found.matches === 1 ? '' : 'es'} in ${
        found.files.length
      } file${found.files.length === 1 ? '' : 's'}${found.truncated ? ', and more beyond the limit' : ''}.</p>` +
      found.files
        .map(
          (file) => `
        <div class="hits">
          <button class="hits__file" type="button" data-open-file="${escapeHtml(file.path)}">
            ${escapeHtml(file.path)} <span class="hits__n">${file.hits.length}</span>
          </button>
          ${file.hits
            .map(
              (hit) => `
            <button class="hits__line" type="button" data-open-file="${escapeHtml(file.path)}">
              <span class="hits__no">${hit.line}</span>
              <span class="hits__text">${mark(hit.text, query)}</span>
            </button>`,
            )
            .join('')}
        </div>`,
        )
        .join('');

    for (const button of body.querySelectorAll('[data-open-file]')) {
      button.addEventListener('click', () => openFile(button.dataset.openFile));
    }
  }

  /** The match, lit up inside its line. Escaped first, always. */
  function mark(line, query) {
    const safe = escapeHtml(line);
    const at = safe.toLowerCase().indexOf(escapeHtml(query).toLowerCase());
    if (at === -1) return safe;
    const end = at + escapeHtml(query).length;
    return `${safe.slice(0, at)}<mark>${safe.slice(at, end)}</mark>${safe.slice(end)}`;
  }

  $('workspace-find').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    const query = event.target.value.trim();
    if (query) runSearch(query);
    else open(at);
  });

  $('workspace-new').addEventListener('click', async () => {
    const name = window.prompt(t('ws.newFilePrompt'), 'notes.md');
    if (!name) return;
    const path = name.includes('/') ? name : (at === '.' ? name : `${at}/${name}`);
    try {
      await api.saveWorkspaceFile(path, '');
      toast(`Created ${path}.`);
      await openFile(path);
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  return { open };
}
