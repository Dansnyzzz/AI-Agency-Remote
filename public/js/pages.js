import { api } from './api.js';
import { escapeHtml } from './markdown.js';
import { openMenu } from './menu.js';
import { editProjectDetails, projectMenuItems } from './project-page.js';
import { workflowsView, workflowForm } from './workflows.js';
import { toast } from './render.js';

/**
 * The shelves: Projects, Artifacts, Scheduled.
 *
 * Pages rather than dialogs, and one shell for all three. A shelf is somewhere
 * you *go* — you look through what is there and pick one — and a sheet floating
 * over the transcript is the wrong shape for that: small, temporary, and
 * implying you were in the middle of something you will be returning to.
 *
 * The header is identical on each: a title, a way to search, a way to order,
 * and the one button that makes a new thing. Written once, because three copies
 * of the same header drift apart one small fix at a time.
 *
 * Everything here is built from strings this file escapes. The names come from
 * the person using it and the artifacts come from a model, so neither is markup.
 */

const $ = (id) => document.getElementById(id);

const ago = (value) => {
  if (!value) return '';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes ago`;
  if (seconds < 172800) return seconds < 86400 ? `${Math.round(seconds / 3600)} hours ago` : 'yesterday';
  if (seconds < 2592000) return `${Math.round(seconds / 86400)} days ago`;
  // Past a month the date is more use than the distance to it.
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Two presses to delete, and the second one deliberate. */
function armed(button, warning, run) {
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
      button.textContent = warning;
      button.classList.add('is-armed');
      setTimeout(reset, 5000);
      return;
    }
    reset();
    try {
      await run();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
}

/**
 * @param openProject  hand a project id to the existing project sheet
 * @param openViewer   hand a file id to the artifact viewer
 * @param openChat     open a conversation, which closes the shelf
 * @param onLeave      restore the conversation view
 */
export function createPages({ openProject, openViewer, openChat, onLeave, onNewProject }) {
  const page = $('page');
  const title = $('page-title');
  const lede = $('page-lede');
  const body = $('page-body');
  const search = $('page-search');
  const sortPill = $('page-sort');
  const newButton = $('page-new');
  const sortMenu = $('page-sort-menu');
  const newMenu = $('page-new-menu');

  /** Which shelf is showing, or null when the conversation is. */
  let showing = null;
  /** What has been typed into the search box, per shelf. */
  let query = '';
  /** How the current shelf is ordered or filtered. */
  let order = 'updated';

  const views = {};

  /* ── the shell ────────────────────────────────────────────────── */

  function closeMenus() {
    sortMenu.hidden = true;
    newMenu.hidden = true;
  }

  function menu(host, items) {
    host.innerHTML = items
      .map(
        (item, i) =>
          `<button type="button" data-pick="${i}" class="${item.active ? 'is-active' : ''}">${
            item.icon ? `<span class="menu__icon">${item.icon}</span>` : ''
          }${escapeHtml(item.label)}</button>`,
      )
      .join('');
    for (const button of host.querySelectorAll('[data-pick]')) {
      button.addEventListener('click', () => {
        closeMenus();
        items[Number(button.dataset.pick)].run();
      });
    }
    host.hidden = false;
  }

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.page__tools')) closeMenus();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenus();
  });

  /**
   * The magnifier becomes the field.
   *
   * Both on screen at once was the bug: a round icon button with nothing left
   * to do, and a box beside it that looked like a second, different search.
   * Pressing the icon swaps one for the other; clearing or pressing Escape
   * swaps back and puts the shelf as it was.
   */
  const searchBox = $('page-search-box');

  function openSearch(on) {
    searchBox.hidden = !on;
    $('page-search-open').hidden = on;
    if (on) {
      search.focus();
      return;
    }
    search.value = '';
    if (query) {
      query = '';
      draw();
    }
  }

  $('page-search-open').addEventListener('click', () => openSearch(true));
  $('page-search-clear').addEventListener('click', () => openSearch(false));

  search.addEventListener('input', () => {
    query = search.value.trim().toLowerCase();
    draw();
  });
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      openSearch(false);
    }
  });

  sortPill.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = sortMenu.hidden;
    closeMenus();
    if (!open) return;
    menu(
      sortMenu,
      views[showing].orders.map((option) => ({
        label: option.label,
        active: option.id === order,
        run: () => {
          // Some orderings are a different *set*, not a different arrangement
          // of the same one — those have to go back to the server.
          const was = order;
          order = option.id;
          renderTools();
          if (option.reload || views[showing].orders.find((o) => o.id === was)?.reload) load();
          else draw();
        },
      })),
    );
  });

  newButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const view = views[showing];
    if (!view.newMenu) return view.onNew();

    const open = newMenu.hidden;
    closeMenus();
    if (open) menu(newMenu, view.newMenu());
  });

  function renderTools() {
    const view = views[showing];
    title.textContent = view.title;
    newButton.textContent = view.newLabel;
    newButton.classList.toggle('page__new--menu', !!view.newMenu);

    lede.hidden = !view.lede;
    if (view.lede) lede.innerHTML = view.lede;

    sortPill.hidden = !view.orders?.length;
    if (view.orders?.length) {
      const current = view.orders.find((o) => o.id === order) || view.orders[0];
      // "Sort by Archived" is not a sentence. An option that changes *which*
      // things are listed rather than their order says so on its own.
      sortPill.innerHTML = current.pill
        ? `<strong>${escapeHtml(current.pill)}</strong>`
        : `${escapeHtml(view.orderLabel)} <strong>${escapeHtml(current.label)}</strong>`;
    }
  }

  /** Everything the current shelf holds, filtered by the search box. */
  let items = [];

  async function draw() {
    const view = views[showing];
    const shown = query ? items.filter((item) => view.matches(item, query)) : items;
    body.innerHTML = view.render(view.sort ? view.sort(shown, order) : shown);
    view.wire?.();
  }

  async function load() {
    const view = views[showing];
    body.innerHTML = '<div class="viewer__loading"><span class="spinner"></span> Loading…</div>';
    try {
      items = await view.load();
      await draw();
    } catch (err) {
      body.innerHTML = `<p class="hint">${escapeHtml(err.message)}</p>`;
    }
  }

  /* ── projects ─────────────────────────────────────────────────── */

  views.projects = {
    title: 'Projects',
    newLabel: 'New project',
    orderLabel: 'Sort by',
    orders: [
      { id: 'updated', label: 'Last updated' },
      { id: 'created', label: 'Date created' },
      { id: 'name', label: 'Name' },
      // Archived projects are a separate shelf, fetched separately — they are
      // never mixed into the list above, which is the entire point of archiving
      // one. Hence a reload rather than a client-side re-sort.
      { id: 'archived', label: 'Archived', pill: 'Archived', reload: true },
    ],
    load: async () => (await api.projects({ archived: order === 'archived' })).projects,
    matches: (project, q) =>
      `${project.name} ${project.instructions || ''}`.toLowerCase().includes(q),
    sort: (list, by) =>
      [...list].sort(
        (a, b) =>
          // Pinned first on every ordering, including by name: a pin is a
          // statement about the shelf, not about one way of reading it.
          Number(!!b.pinned) - Number(!!a.pinned) ||
          (by === 'name'
            ? a.name.localeCompare(b.name)
            : new Date(by === 'created' ? b.created_at : b.updated_at) -
              new Date(by === 'created' ? a.created_at : a.updated_at)),
      ),
    render: (list) => {
      if (!list.length) {
        if (order === 'archived') {
          return blank(folderMark, query ? 'No archived project matches that.' : 'Nothing archived.', '');
        }
        return blank(
          folderMark,
          query ? 'No project matches that.' : 'No projects yet.',
          query ? '' : 'A project keeps its instructions and its documents in one place, and every conversation started inside it answers from those documents.',
        );
      }
      return `<div class="cards cards--wide">${list
        .map(
          (project) => `
        <div class="card" data-project="${escapeHtml(project.id)}" role="button" tabindex="0">
          ${project.pinned ? '<span class="card__pin" aria-label="Pinned">📌</span>' : ''}
          <button class="card__more" type="button" aria-haspopup="menu"
                  data-more="${escapeHtml(project.id)}"
                  aria-label="Options for ${escapeHtml(project.name)}">⋮</button>
          <span class="card__name">${escapeHtml(project.name)}</span>
          ${project.instructions ? `<span class="card__note">${escapeHtml(project.instructions)}</span>` : ''}
          <span class="card__facts">
            <span>${escapeHtml(plural(project.file_count, 'source'))}</span>
            <span>·</span>
            <span>${escapeHtml(plural(project.chat_count, 'conversation'))}</span>
          </span>
          <span class="card__when">${escapeHtml(ago(project.updated_at))}</span>
        </div>`,
        )
        .join('')}</div>`;
    },
    wire: () => {
      const byId = new Map(items.map((project) => [project.id, project]));

      for (const card of body.querySelectorAll('[data-project]')) {
        const go = () => openProject(card.dataset.project);
        card.addEventListener('click', (event) => {
          if (event.target.closest('[data-more]')) return;
          go();
        });
        card.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            go();
          }
        });
      }

      for (const button of body.querySelectorAll('[data-more]')) {
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          const project = byId.get(button.dataset.more);
          if (!project) return;
          openMenu(
            button,
            projectMenuItems(project, {
              after: load,
              onGone: load,
              onEdit: async (which) => {
                if (await editProjectDetails(which)) load();
              },
            }),
          );
        });
      }
    },
    onNew: () => onNewProject(),
  };

  /* ── artifacts ────────────────────────────────────────────────── */

  const CODE = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|cs|c|h|cpp|php|sh|ps1|sql|css|scss|ya?ml|toml|ini|xml|json)$/i;
  const kindOf = (file) => {
    const name = String(file.name || '');
    if (/\.html?$/i.test(name)) return 'page';
    if (CODE.test(name)) return 'code';
    if (/\.(docx|md|txt|pdf)$/i.test(name)) return 'document';
    if (/\.(xlsx|csv)$/i.test(name)) return 'sheet';
    if (/\.pptx$/i.test(name)) return 'deck';
    return 'other';
  };

  views.artifacts = {
    title: 'Artifacts',
    newLabel: 'New artifact',
    orderLabel: 'Filter by',
    orders: [
      { id: 'all', label: 'All' },
      { id: 'page', label: 'Pages' },
      { id: 'code', label: 'Code' },
      { id: 'document', label: 'Documents' },
      { id: 'sheet', label: 'Spreadsheets' },
      { id: 'deck', label: 'Decks' },
    ],
    load: async () => (await api.files()).files,
    matches: (file, q) => `${file.name} ${file.chat_title || ''}`.toLowerCase().includes(q),
    sort: (list, by) => (by === 'all' ? list : list.filter((file) => kindOf(file) === by)),
    render: (list) => {
      if (!list.length) {
        return blank(
          artifactMark,
          query || order !== 'all' ? 'Nothing here matches.' : 'No artifacts yet.',
          query || order !== 'all'
            ? ''
            : 'Ask for a report, a quotation, a spreadsheet or a small page and it appears here — and stays, whichever conversation it came from.',
        );
      }
      return `<div class="cards">${list
        .map((file) => {
          const kind = kindOf(file);
          const peek = file.peek || '';
          return `
        <div class="card card--artifact" data-file="${escapeHtml(file.id)}">
          <div class="card__peek ${kind === 'code' || kind === 'page' ? 'card__peek--code' : ''} ${
            peek ? '' : 'card__peek--empty'
          }">${peek ? escapeHtml(peek) : artifactMark}</div>
          <div class="card__foot">
            <span class="card__name">${escapeHtml(file.name)}</span>
            <span class="card__when">Edited ${escapeHtml(ago(file.created_at))}${
              file.chat_title ? ` · ${escapeHtml(file.chat_title)}` : ''
            } · ${escapeHtml(humanSize(file.bytes || 0))}</span>
          </div>
        </div>`;
        })
        .join('')}</div>`;
    },
    wire: () => {
      for (const card of body.querySelectorAll('[data-file]')) {
        card.addEventListener('click', () => openViewer(card.dataset.file));
      }
    },
    onNew: () => {
      onLeave();
      toast('Ask for what you want made — a report, a spreadsheet, a small page.');
    },
  };

  /* ── scheduled ────────────────────────────────────────────────── */

  /**
   * Things worth scheduling *in this application*.
   *
   * Not a copy of somebody else's list: every one of these is a prompt the
   * tools here can actually carry out. Offering a calendar briefing to an app
   * with no calendar would look right in a screenshot and do nothing on a
   * Tuesday morning.
   */
  const IDEAS = [
    {
      name: 'Morning briefing',
      what: 'What changed overnight in the things you follow, searched and summarised.',
      when: 'Weekdays at 08:00',
      cron: '08:00',
      prompt:
        'Search the web for what changed in the last 24 hours on the topics I follow, and write me a short briefing. Lead with anything that actually matters; say plainly if nothing did.',
      mark: '☀',
    },
    {
      name: 'Watch a topic',
      what: 'Check for news about something, and only speak up when there is any.',
      when: 'Daily at 09:00',
      cron: '09:00',
      prompt:
        'Search for news about [topic] since yesterday. If nothing material has happened, say so in one line and stop — do not pad it out.',
      mark: '◎',
    },
    {
      name: 'Weekly report',
      what: 'A Word document summarising the week, made and left in the conversation.',
      when: 'Fridays at 16:00',
      cron: 'fri 16:00',
      prompt:
        'Summarise what we worked on this week and make it a .docx with create_file: what was done, what is outstanding, and what needs a decision.',
      mark: '▤',
    },
    {
      name: 'Check the workspace',
      what: 'Run the tests on your machine and report what failed.',
      when: 'Weekdays at 09:00',
      cron: '09:00',
      prompt:
        'In my workspace, run the test suite and report the result. If anything failed, show the relevant output and say what you think is wrong.',
      mark: '⟨⟩',
    },
  ];

  views.scheduled = {
    title: 'Scheduled tasks',
    newLabel: 'New task',
    orderLabel: 'Sort by',
    lede:
      'Work that runs on a clock, or whenever you press it. Each run lands in its own conversation, ready to read later.',
    orders: [
      { id: 'next', label: 'Next run' },
      { id: 'name', label: 'Name' },
    ],
    load: async () => (await api.tasks()).tasks,
    matches: (task, q) => `${task.title} ${task.prompt || ''}`.toLowerCase().includes(q),
    sort: (list, by) =>
      [...list].sort((a, b) =>
        by === 'name' ? a.title.localeCompare(b.title) : new Date(a.next_run_at) - new Date(b.next_run_at),
      ),
    newMenu: () => [
      {
        label: 'Describe it to the assistant',
        icon: '💬',
        run: () => {
          onLeave();
          toast('Tell it what to run and when — "every weekday at 8, search for…"');
        },
      },
      { label: 'Set up manually', icon: '⚙', run: () => openTaskForm() },
    ],
    render: (list) => {
      const local = state.localOnly
        ? `<div class="notice">
             <span class="notice__say">
               Scheduled tasks run while this app is running. On a deployment they run without it.
             </span>
           </div>`
        : '';

      if (!list.length) {
        return (
          local +
          blank(clockMark, 'No scheduled tasks yet.', '') +
          '<div class="blank__rule"></div>' +
          `<div class="ideas">${IDEAS.map(
            (idea, i) => `
            <button class="idea" type="button" data-idea="${i}">
              <span class="idea__mark">${idea.mark}</span>
              <span>
                <span class="idea__name">${escapeHtml(idea.name)}</span>
                <span class="idea__what">${escapeHtml(idea.what)}</span>
                <span class="idea__when">🕘 ${escapeHtml(idea.when)}</span>
              </span>
            </button>`,
          ).join('')}</div>`
        );
      }

      return (
        local +
        list
          .map(
            (task) => `
        <div class="task${task.enabled ? '' : ' task--off'}">
          <span class="task__dot"></span>
          <div class="task__body">
            <div class="task__name">${escapeHtml(task.title)}</div>
            <div class="task__what">${escapeHtml(task.prompt || '')}</div>
            <div class="task__when">
              ${escapeHtml(task.cron ? `every ${task.cron}` : 'once')}
              · ${task.enabled ? `next ${escapeHtml(ago(task.next_run_at))}` : 'paused'}
              ${task.last_status ? `· last ${escapeHtml(String(task.last_status).slice(0, 40))}` : ''}
            </div>
          </div>
          ${task.last_chat ? `<button class="task__act" data-open="${escapeHtml(task.last_chat)}">Open result</button>` : ''}
          <button class="task__act" data-toggle="${escapeHtml(task.id)}" data-on="${!!task.enabled}">${
            task.enabled ? 'Pause' : 'Resume'
          }</button>
          <button class="task__act" data-drop="${escapeHtml(task.id)}">Remove</button>
        </div>`,
          )
          .join('')
      );
    },
    wire: () => {
      for (const button of body.querySelectorAll('[data-idea]')) {
        button.addEventListener('click', () => openTaskForm(IDEAS[Number(button.dataset.idea)]));
      }
      for (const button of body.querySelectorAll('[data-open]')) {
        button.addEventListener('click', () => {
          onLeave();
          openChat(button.dataset.open);
        });
      }
      for (const button of body.querySelectorAll('[data-toggle]')) {
        button.addEventListener('click', async () => {
          await api.setTaskEnabled(button.dataset.toggle, button.dataset.on !== 'true');
          load();
        });
      }
      for (const button of body.querySelectorAll('[data-drop]')) {
        armed(button, 'Remove?', async () => {
          await api.deleteTask(button.dataset.drop);
          load();
        });
      }
    },
    onNew: () => openTaskForm(),
  };

  /* ── workflows ────────────────────────────────────────────────── */

  // The fourth shelf, and the only one whose contents live in their own file:
  // it reuses this shell but is otherwise self-contained, so `pages.js` does not
  // grow another two hundred lines every time a shelf is added.
  const wfForm = workflowForm({
    toast,
    reload: () => (showing === 'workflows' ? load() : null),
  });

  views.workflows = workflowsView({
    blank: (mark, say, note) => blank(mark, say, note),
    body,
    toast,
    openChat,
    onLeave,
    openForm: (id) => wfForm.open(id),
    reload: () => load(),
  });

  /* ── the create-a-task form ───────────────────────────────────── */

  function openTaskForm(idea = null) {
    const sheet = $('task-form');
    $('task-form-name').value = idea?.name || '';
    $('task-form-prompt').value = idea?.prompt || '';
    $('task-form-when').value = idea?.cron || '08:00';
    $('task-form-repeat').value = idea ? 'repeat' : 'repeat';
    $('task-form-error').textContent = '';
    sheet.showModal();
    $('task-form-name').focus();
  }

  $('task-form-save').addEventListener('click', async () => {
    const button = $('task-form-save');
    const error = $('task-form-error');
    button.disabled = true;
    try {
      await api.createTask({
        title: $('task-form-name').value.trim(),
        prompt: $('task-form-prompt').value.trim(),
        when: $('task-form-when').value.trim(),
        repeat: $('task-form-repeat').value === 'repeat',
      });
      $('task-form').close();
      toast('Scheduled.');
      if (showing === 'scheduled') load();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  /* ── shared furniture ─────────────────────────────────────────── */

  const blank = (mark, say, note) => `
    <div class="blank">
      <div class="blank__ring">${mark}</div>
      <div class="blank__say">${escapeHtml(say)}</div>
      ${note ? `<p class="hint" style="max-width:46ch">${escapeHtml(note)}</p>` : ''}
    </div>`;

  const clockMark =
    '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="20" cy="22" r="13"/><path d="M20 15v7l4.5 2.8M15 4.5 11 7.5M25 4.5l4 3"/></svg>';
  const folderMark =
    '<svg viewBox="0 0 40 40" width="40" height="40" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 11a3 3 0 0 1 3-3h6.5l3 3.6H32a3 3 0 0 1 3 3V29a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3Z"/></svg>';
  const artifactMark =
    '<svg viewBox="0 0 40 40" width="34" height="34" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M23 5H11a3 3 0 0 0-3 3v24a3 3 0 0 0 3 3h18a3 3 0 0 0 3-3V14Z"/><path d="M23 5v9h9"/><path d="m16 21-3 3 3 3M24 21l3 3-3 3" stroke-linecap="round"/></svg>';

  /* ── the way in ───────────────────────────────────────────────── */

  const state = { localOnly: false };

  return {
    /** Called once at boot so the notice can say where tasks actually run. */
    configure({ localMachine }) {
      state.localOnly = !!localMachine;
    },

    async show(which) {
      if (!views[which]) return;
      showing = which;
      query = '';
      order = views[which].orders?.[0]?.id || 'all';
      search.value = '';
      searchBox.hidden = true;
      $('page-search-open').hidden = false;
      search.placeholder = `Search ${views[which].title.toLowerCase()}…`;
      closeMenus();

      page.hidden = false;
      $('thread').hidden = true;
      $('dock').hidden = true;
      page.scrollTop = 0;

      renderTools();
      await load();
    },

    /** Back to the conversation. */
    hide() {
      showing = null;
      page.hidden = true;
      $('thread').hidden = false;
      $('dock').hidden = false;
      closeMenus();
    },

    showing: () => showing,
    /** Reload the shelf on screen, if it is one of these. */
    refresh: () => (showing ? load() : null),
  };
}
