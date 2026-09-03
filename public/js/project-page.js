import { api } from './api.js';
import { t } from './i18n.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
import { toast } from './render.js';

/**
 * One project, opened.
 *
 * A page rather than the old sheet, because a project is a place you work
 * *from*: conversations start here, and what the assistant reads while you are
 * here is set here. A dialog floating over somebody else's transcript said the
 * opposite — that you were passing through.
 *
 * Two columns. The left is the work: a composer, then the conversations this
 * project has already produced. The right is what the work reads from —
 * instructions, memory, and the documents on the shelf. Everything on the right
 * is labelled with what it actually is; see the memory card in particular.
 */

const $ = (id) => document.getElementById(id);

/**
 * A count and its noun, as a whole phrase — the same helper `pages.js` uses.
 *
 * The English pluralisation rule this replaced could not be translated, only
 * replaced: Vietnamese does not inflect the noun, so the translation has to own
 * the entire phrase rather than a stem the formatter adds an `s` to.
 */
const counted = (n, key) => (n === 1 ? t(`${key}One`) : t(key)).replace('{n}', String(n));

const fmtChars = (n) => {
  const say = (key, value) => t(key).replace('{n}', String(value));
  if (n >= 1_000_000) return say('count.charsM', (n / 1_000_000).toFixed(1));
  if (n >= 1000) return say('count.charsK', Math.round(n / 1000));
  return say('count.chars', n);
};

const ago = (value) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const n = (key, count) => t(key).replace('{n}', String(count));
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return t('when.justNow');
  if (seconds < 3600) return n('when.minutes', Math.round(seconds / 60));
  if (seconds < 172800) {
    return seconds < 86400 ? n('when.hours', Math.round(seconds / 3600)) : t('when.yesterday');
  }
  if (seconds < 2592000) return n('when.days', Math.round(seconds / 86400));
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

/** A File as base64, without the `data:…;base64,` preamble the server does not want. */
function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.readAsDataURL(file);
  });
}

/** Text as base64, going through UTF-8 first — `btoa` alone throws on anything accented. */
const textToBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * The four things you can do to a project from a ⋮ menu.
 *
 * Shared between the shelf and this page so the two never drift: a card that
 * offers "Archive" and a header that does not would be the same object with two
 * different sets of rules.
 *
 * @param project  the row, as the API returns it
 * @param after    called once something actually changed
 * @param onGone   called when the project no longer exists (deleted)
 */
export function projectMenuItems(project, { after, onGone, onEdit }) {
  const pinned = !!project.pinned;
  const archived = !!project.archived_at;

  const patch = async (body, said) => {
    try {
      await api.updateProject(project.id, body);
      toast(said);
      await after?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return [
    {
      label: pinned ? t('proj.unpin') : t('proj.pin'),
      icon: '📌',
      run: () => patch({ pinned: !pinned }, pinned ? t('proj.unpinned') : t('proj.pinned')),
    },
    { label: t('proj.editDetails'), icon: '✎', run: () => onEdit(project) },
    {
      label: archived ? t('proj.restore') : t('proj.archive'),
      icon: '🗄',
      run: () =>
        patch(
          { archived: !archived },
          archived ? t('proj.restored') : t('proj.archived'),
        ),
    },
    null,
    {
      label: t('proj.delete'),
      icon: '🗑',
      danger: true,
      run: async () => {
        // A real confirm, not a two-press button: this one is permanent, and
        // the menu it was chosen from has already closed, so there is nothing
        // left on screen to arm.
        const sure = window.confirm(t('proj.deleteConfirm').replace('{name}', project.name));
        if (!sure) return;
        try {
          await api.deleteProject(project.id);
          toast(t('proj.deleted'));
          await onGone?.();
        } catch (err) {
          toast(err.message, 'error');
        }
      },
    },
  ];
}

/**
 * The edit-details dialog, shared for the same reason the menu is.
 * Resolves to the updated project, or null if it was cancelled.
 */
export function editProjectDetails(project) {
  return new Promise((resolve) => {
    const dialog = $('project-edit');
    const name = $('project-edit-name');
    const about = $('project-edit-about');
    const error = $('project-edit-error');
    const save = $('project-edit-save');
    const cancel = $('project-edit-cancel');

    name.value = project.name || '';
    about.value = project.instructions || '';
    error.textContent = '';

    const done = (value) => {
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onCancel = () => done(null);
    const onClose = () => done(null);
    async function onSave() {
      const value = name.value.trim();
      if (!value) {
        error.textContent = t('proj.needName');
        return;
      }
      save.disabled = true;
      try {
        const { project: updated } = await api.updateProject(project.id, {
          name: value,
          instructions: about.value,
        });
        done(updated);
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    }

    save.addEventListener('click', onSave);
    cancel.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    name.focus();
    name.select();
  });
}

/**
 * @param openChat   open one of this project's conversations
 * @param startChat  begin a new conversation in this project, carrying the first message
 * @param onBack     return to the Projects shelf
 */
export function createProjectPage({ openChat, startChat, onBack }) {
  const page = $('project-page');
  const nameEl = $('project-page-name');
  const crumb = $('project-page-crumb');
  const pinButton = $('project-page-pin');
  const moreButton = $('project-page-more');
  const ask = $('project-page-ask');
  const send = $('project-page-send');
  const chip = $('project-page-chip');
  const chatList = $('project-page-chats');
  const side = $('project-page-side');

  /** Everything the last load returned: `{ project, files, chats, memory }`. */
  let data = null;
  /** True while the instructions card is a textarea rather than a paragraph. */
  let editingInstructions = false;

  /* ── the page ─────────────────────────────────────────────────── */

  function draw() {
    const { project, files, chats, memory } = data;

    crumb.textContent = project.name;
    nameEl.textContent = project.name;
    document.title = `${project.name} · AI Remote`;

    pinButton.classList.toggle('is-on', !!project.pinned);
    pinButton.setAttribute('aria-pressed', String(!!project.pinned));
    pinButton.setAttribute('aria-label', project.pinned ? t('proj.unpinAria') : t('proj.pinAria'));

    chip.textContent = files.length
      ? t(project.grounded ? 'proj.answersFrom' : 'proj.answersFirstFrom').replace(
          '{sources}',
          counted(files.length, 'count.sources'),
        )
      : t('proj.noSources');

    drawChats(chats);
    drawSide(project, files, memory);
  }

  function drawChats(chats) {
    if (!chats.length) {
      chatList.innerHTML = `
        <div class="project__empty">
          <div class="blank__ring">${chatMark}</div>
          <div class="blank__say">No conversations in this project yet.</div>
          <p class="hint" style="max-width:44ch">
            Anything you ask above starts here and stays here, with the project's instructions
            and sources already in front of it.
          </p>
        </div>`;
      return;
    }

    chatList.innerHTML =
      `<h2 class="panel-card__name" style="margin:26px 0 12px">${escapeHtml(
        counted(chats.length, 'count.conversations'),
      )}</h2>` +
      chats
        .map(
          (chat) => `
        <button class="chatline" type="button" data-chat="${escapeHtml(chat.id)}">
          <span class="chatline__name">${escapeHtml(chat.title || t('proj.untitled'))}</span>
          <span class="chatline__when">${escapeHtml(counted(chat.message_count, 'count.messages'))}</span>
        </button>`,
        )
        .join('');

    for (const button of chatList.querySelectorAll('[data-chat]')) {
      button.addEventListener('click', () => openChat(button.dataset.chat));
    }
  }

  function drawSide(project, files, memory) {
    side.innerHTML = `
      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">Instructions</span>
          <button class="panel-card__add" id="pp-edit-instructions" type="button"
                  aria-label="${escapeHtml(editingInstructions ? t('action.cancel') : t('proj.editInstructions'))}">${
                    editingInstructions ? '✕' : '✎'
                  }</button>
        </div>
        ${
          editingInstructions
            ? `<textarea id="pp-instructions">${escapeHtml(project.instructions || '')}</textarea>
               <div class="panel-card__foot">
                 <button class="btn btn--primary" id="pp-save-instructions" type="button">Save</button>
               </div>`
            : `<p class="panel-card__say">${
                project.instructions
                  ? escapeHtml(project.instructions)
                  : 'Nothing standing yet. Anything written here is carried into every conversation in this project, so it never has to be re-explained.'
              }</p>`
        }
      </section>

      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">Memory</span>
          <span class="panel-card__tag" title="${escapeHtml(t('proj.memoryScope'))}">${escapeHtml(t('proj.accountWide'))}</span>
        </div>
        ${
          memory.length
            ? `<p class="panel-card__say" style="margin-bottom:8px">
                 What the assistant has remembered about you. It is the <strong>same set of notes in every
                 project</strong> and in ordinary chats — not a memory belonging to this one.
               </p>` +
              memory
                .map(
                  (note) => `
              <div class="source">
                <span class="source__name" title="${escapeHtml(note.content)}">${escapeHtml(
                  note.content.slice(0, 90),
                )}</span>
                <span class="source__size">${escapeHtml(ago(note.updatedAt))}</span>
              </div>`,
                )
                .join('')
            : `<p class="panel-card__say">
                 Nothing remembered yet. Tell the assistant something worth keeping — how you like things
                 written, what you are working on — and it saves a note. Those notes are shared across
                 every project on this account, not held by this one.
               </p>`
        }
      </section>

      <section class="panel-card">
        <div class="panel-card__head">
          <span class="panel-card__name">Context</span>
          <button class="panel-card__add" id="pp-add-source" type="button"
                  aria-haspopup="menu" aria-label="${escapeHtml(t('proj.addContext'))}">+</button>
        </div>
        ${
          files.length
            ? files
                .map(
                  (file) => `
              <div class="source">
                <span class="source__name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                <span class="source__size">${escapeHtml(
                  [file.pages ? counted(file.pages, 'count.pages') : null, fmtChars(file.chars)].filter(Boolean).join(' · '),
                )}</span>
                <button class="source__drop" type="button" data-drop="${escapeHtml(
                  file.id,
                )}" aria-label="${escapeHtml(t('proj.removeAria').replace('{name}', file.name))}">✕</button>
              </div>`,
                )
                .join('')
            : ''
        }
        <div class="dropzone" id="pp-dropzone" tabindex="0" role="button">
          <span>${uploadMark}</span>
          <span>Drop a file here, or press to choose one</span>
          <span style="font-size:11.5px">PDF, Word, Excel, PowerPoint, text and code</span>
        </div>
        <p class="panel-card__say" style="margin-top:10px">
          Sources are stored as the text read out of them, which is what the assistant quotes.
        </p>
      </section>`;

    wireSide();
  }

  function wireSide() {
    $('pp-edit-instructions').addEventListener('click', () => {
      editingInstructions = !editingInstructions;
      drawSide(data.project, data.files, data.memory);
      if (editingInstructions) $('pp-instructions').focus();
    });

    $('pp-save-instructions')?.addEventListener('click', async () => {
      const button = $('pp-save-instructions');
      button.disabled = true;
      try {
        const { project } = await api.updateProject(data.project.id, {
          instructions: $('pp-instructions').value,
        });
        data.project = project;
        editingInstructions = false;
        draw();
        toast(t('proj.instructionsSaved'));
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
    });

    for (const button of side.querySelectorAll('[data-drop]')) {
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          await api.deleteProjectFile(data.project.id, button.dataset.drop);
          await reload();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
        }
      });
    }

    /**
     * What can actually be added, and nothing else.
     *
     * Claude's menu offers GitHub and Google Drive here. Neither exists in this
     * application, and a menu entry that opens an apology is worse than no
     * entry — so the list is the two things that work.
     */
    $('pp-add-source').addEventListener('click', (event) => {
      event.stopPropagation();
      openMenu($('pp-add-source'), [
        { label: t('proj.uploadFromDevice'), icon: '⤒', run: () => pick() },
        { label: t('proj.addTextContent'), icon: '¶', run: () => addTextSource() },
      ]);
    });

    const zone = $('pp-dropzone');
    zone.addEventListener('click', pick);
    zone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        pick();
      }
    });
    zone.addEventListener('dragover', (event) => {
      event.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (event) => {
      event.preventDefault();
      zone.classList.remove('is-over');
      upload([...(event.dataTransfer?.files || [])]);
    });
  }

  /* ── adding sources ───────────────────────────────────────────── */

  const filePicker = document.createElement('input');
  filePicker.type = 'file';
  filePicker.multiple = true;
  filePicker.hidden = true;
  document.body.appendChild(filePicker);
  filePicker.addEventListener('change', () => {
    const files = [...(filePicker.files || [])];
    filePicker.value = ''; // so the same file can be chosen again after a failure
    upload(files);
  });

  const pick = () => filePicker.click();

  async function upload(files) {
    if (!files.length) return;
    const zone = $('pp-dropzone');
    let added = 0;

    for (const [i, file] of files.entries()) {
      if (zone) zone.lastElementChild.textContent = `Reading ${file.name}… (${i + 1} of ${files.length})`;
      try {
        await api.addProjectFile(data.project.id, {
          name: file.name,
          mime: file.type,
          data: await readAsBase64(file),
        });
        added += 1;
      } catch (err) {
        // Named, one at a time. "Some files failed" tells nobody which one to
        // fix, and a scanned PDF is a different problem from one that is too big.
        toast(err.message, 'error');
      }
    }

    if (added) toast(t('proj.addedSources').replace('{sources}', counted(added, 'count.sources')));
    await reload();
  }

  function addTextSource() {
    const dialog = $('text-source');
    const name = $('text-source-name');
    const body = $('text-source-body');
    const error = $('text-source-error');
    const save = $('text-source-save');
    const cancel = $('text-source-cancel');

    name.value = '';
    body.value = '';
    error.textContent = '';

    const done = () => {
      save.removeEventListener('click', onSave);
      cancel.removeEventListener('click', done);
      if (dialog.open) dialog.close();
    };
    async function onSave() {
      const text = body.value.trim();
      if (!text) {
        error.textContent = t('proj.nothingToAdd');
        return;
      }
      const label = name.value.trim() || t('proj.pastedText');
      save.disabled = true;
      try {
        await api.addProjectFile(data.project.id, {
          name: /\.\w{1,5}$/.test(label) ? label : `${label}.txt`,
          mime: 'text/plain',
          data: textToBase64(text),
        });
        done();
        toast(t('proj.added'));
        await reload();
      } catch (err) {
        error.textContent = err.message;
      } finally {
        save.disabled = false;
      }
    }

    save.addEventListener('click', onSave);
    cancel.addEventListener('click', done);
    dialog.showModal();
    name.focus();
  }

  /* ── the header ───────────────────────────────────────────────── */

  pinButton.addEventListener('click', async () => {
    const next = !data.project.pinned;
    try {
      const { project } = await api.updateProject(data.project.id, { pinned: next });
      data.project = project;
      draw();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  moreButton.addEventListener('click', (event) => {
    event.stopPropagation();
    openMenu(
      moreButton,
      projectMenuItems(data.project, {
        after: reload,
        onGone: onBack,
        onEdit: async (project) => {
          const updated = await editProjectDetails(project);
          if (updated) await reload();
        },
      }),
    );
  });

  $('project-page-back').addEventListener('click', () => onBack());

  /* ── starting a conversation ──────────────────────────────────── */

  const sizeAsk = () => {
    ask.style.height = 'auto';
    ask.style.height = `${Math.min(ask.scrollHeight, 220)}px`;
  };

  ask.addEventListener('input', () => {
    send.disabled = !ask.value.trim();
    sizeAsk();
  });

  ask.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      go();
    }
  });

  send.addEventListener('click', go);

  function go() {
    const text = ask.value.trim();
    if (!text) return;
    // Nothing is created here: the conversation comes into existence at its
    // first message, carrying the project with it.
    startChat(
      { id: data.project.id, name: data.project.name, grounded: data.project.grounded, files: data.files.length },
      text,
    );
    ask.value = '';
    send.disabled = true;
    sizeAsk();
  }

  /* ── loading ──────────────────────────────────────────────────── */

  async function reload() {
    const fresh = await api.project(data.project.id);
    data = { ...fresh, memory: fresh.memory || [] };
    draw();
  }

  const chatMark =
    '<svg viewBox="0 0 40 40" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6 12a4 4 0 0 1 4-4h20a4 4 0 0 1 4 4v11a4 4 0 0 1-4 4H16l-7 6v-6a3 3 0 0 1-3-3Z"/></svg>';
  const uploadMark =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4m0 0 4 4m-4-4-4 4"/><path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>';

  return {
    /** Show the page for one project. Rejects nothing — it says so on screen. */
    async open(id) {
      page.hidden = false;
      $('page').hidden = true;
      $('thread').hidden = true;
      $('dock').hidden = true;
      page.scrollTop = 0;
      editingInstructions = false;
      ask.value = '';
      send.disabled = true;

      side.innerHTML = '<div class="viewer__loading"><span class="spinner"></span> Loading…</div>';
      chatList.innerHTML = '';
      try {
        const fresh = await api.project(id);
        data = { ...fresh, memory: fresh.memory || [] };
        draw();
      } catch (err) {
        crumb.textContent = '';
        nameEl.textContent = t('proj.fallbackName');
        side.innerHTML = `<p class="hint" style="padding:18px 20px">${escapeHtml(err.message)}</p>`;
      }
    },

    hide() {
      page.hidden = true;
      document.title = 'AI Remote';
    },

    /** The id on screen, or null. Used to decide whether a refresh applies. */
    showing: () => (page.hidden ? null : data?.project?.id ?? null),
  };
}
