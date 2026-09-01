import { api } from './api.js';
import { escapeHtml } from './markdown.js';

/**
 * The Workflows shelf.
 *
 * A scheduled task is one instruction. A workflow is several, in order, where
 * each one may depend on what the last produced — and the reason it is a
 * separate thing rather than a longer prompt is that it **keeps its position**.
 * A deployment is cut off at 300 seconds; a workflow interrupted at step three
 * resumes at step three instead of sending the same email a second time.
 *
 * Which makes the per-step state the whole point of this screen. "It didn't
 * arrive" is answered here by naming the step that stopped and what it said,
 * rather than by one status line for a job with four parts.
 *
 * It lives in its own file rather than in `pages.js` because that file is
 * already the shell for three shelves; the shell is reused, the contents are
 * not pasted into it. Everything below is built from strings, and every value
 * that came from a person or a model goes through `escapeHtml`.
 */

/** How a step reads on screen, and what it means. */
const STEP_LOOK = {
  pending: { mark: '○', say: 'waiting' },
  running: { mark: '◐', say: 'running' },
  done: { mark: '●', say: 'done' },
  failed: { mark: '✕', say: 'failed' },
  unknown: { mark: '?', say: 'interrupted — not repeated' },
};

const RUN_LOOK = {
  running: 'in progress',
  done: 'finished',
  failed: 'stopped on a failure',
  needs_attention: 'waiting for you',
  cancelled: 'cancelled',
};

const clip = (text, max = 140) => {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/**
 * @param blank      the shell's empty-state renderer
 * @param body       the shelf's container, for binding events after a render
 * @param toast      transient confirmation
 * @param openChat   go to the conversation a run wrote into
 * @param onLeave    close the shelf first
 * @param openForm   the create/edit sheet, owned by the page shell
 * @param reload     re-run the shelf's own load
 */
export function workflowsView({ blank, body, toast, openChat, onLeave, openForm, reload }) {
  return {
    title: 'Workflows',
    newLabel: 'New workflow',
    orderLabel: 'Sort by',
    lede:
      'Several steps, in order, run without anyone watching. Each step sees what the last one produced, ' +
      'and a run that is interrupted carries on where it stopped rather than starting again.',
    orders: [
      { id: 'recent', label: 'Recently added' },
      { id: 'name', label: 'Name' },
    ],

    load: async () => (await api.workflows()).workflows,

    matches: (wf, q) =>
      `${wf.title} ${(wf.steps || []).map((s) => s.instruction).join(' ')}`.toLowerCase().includes(q),

    sort: (list, by) =>
      [...list].sort((a, b) =>
        by === 'name' ? a.title.localeCompare(b.title) : new Date(b.created_at) - new Date(a.created_at),
      ),

    newMenu: () => [
      {
        label: 'Describe it to the assistant',
        icon: '💬',
        run: () => {
          onLeave();
          toast('Say the steps in order — "every Monday: pull the numbers, chart them, email the team".');
        },
      },
      { label: 'Set up manually', icon: '⚙', run: () => openForm() },
    ],

    render: (list) => {
      if (!list.length) {
        return blank(
          workflowMark,
          'No workflows yet.',
          'Use one when a job has stages that must happen in order — and when repeating a stage by ' +
            'accident would be a problem. A single instruction is a scheduled task instead.',
        );
      }

      return list
        .map((wf) => {
          const run = wf.lastRun;
          const steps = wf.steps || [];
          const state = run?.steps || [];

          const trail = steps
            .map((step, i) => {
              const status = state[i]?.status || 'pending';
              const look = STEP_LOOK[status] || STEP_LOOK.pending;
              const why = state[i]?.error ? ` — ${clip(state[i].error, 120)}` : '';
              return `
                <li class="wf__step wf__step--${escapeHtml(status)}">
                  <span class="wf__step-mark" aria-hidden="true">${look.mark}</span>
                  <span class="wf__step-text">
                    ${escapeHtml(clip(step.instruction))}
                    <span class="wf__step-say">${escapeHtml(look.say)}${escapeHtml(why)}</span>
                  </span>
                </li>`;
            })
            .join('');

          const attention =
            run?.status === 'needs_attention'
              ? `<p class="wf__flag">A step was interrupted and is <strong>not repeated automatically</strong> —
                   there is no way to tell whether what it does had already happened. Check the conversation,
                   then run it again if it still needs doing.</p>`
              : '';

          return `
        <div class="wf${wf.enabled ? '' : ' wf--off'}">
          <div class="wf__head">
            <div>
              <div class="wf__name">${escapeHtml(wf.title)}</div>
              <div class="wf__when">
                ${escapeHtml(wf.cron ? `every ${wf.cron}` : 'runs when you press it')}
                ${wf.enabled ? '' : ' · paused'}
                ${run ? ` · last run ${escapeHtml(RUN_LOOK[run.status] || run.status)}` : ' · never run'}
              </div>
            </div>
            <div class="wf__acts">
              ${run?.chat_id ? `<button class="task__act" data-open="${escapeHtml(run.chat_id)}">Open result</button>` : ''}
              <button class="task__act" data-run="${escapeHtml(wf.id)}">Run now</button>
              <button class="task__act" data-edit="${escapeHtml(wf.id)}">Edit</button>
              <button class="task__act" data-toggle="${escapeHtml(wf.id)}" data-on="${!!wf.enabled}">${
                wf.enabled ? 'Pause' : 'Resume'
              }</button>
              <button class="task__act" data-drop="${escapeHtml(wf.id)}">Remove</button>
            </div>
          </div>
          ${attention}
          <ol class="wf__steps">${trail}</ol>
        </div>`;
        })
        .join('');
    },

    wire: () => {
      for (const button of body.querySelectorAll('[data-open]')) {
        button.addEventListener('click', () => {
          onLeave();
          openChat(button.dataset.open);
        });
      }

      for (const button of body.querySelectorAll('[data-run]')) {
        button.addEventListener('click', async () => {
          // The request is held open while steps execute, so the button has to
          // say so — several minutes of an apparently dead page is how someone
          // presses it a second time and starts a second run.
          const was = button.textContent;
          button.disabled = true;
          button.textContent = 'Running…';
          try {
            const { run } = await api.runWorkflow(button.dataset.run);
            toast(
              run?.status === 'done'
                ? 'Finished.'
                : run?.status === 'running'
                  ? 'Started — it will carry on in the background.'
                  : `Stopped: ${RUN_LOOK[run?.status] || run?.status || 'unknown'}.`,
            );
          } catch (err) {
            toast(err.message);
          } finally {
            button.disabled = false;
            button.textContent = was;
            reload();
          }
        });
      }

      for (const button of body.querySelectorAll('[data-edit]')) {
        button.addEventListener('click', () => openForm(button.dataset.edit));
      }

      for (const button of body.querySelectorAll('[data-toggle]')) {
        button.addEventListener('click', async () => {
          await api.updateWorkflow(button.dataset.toggle, { enabled: button.dataset.on !== 'true' });
          reload();
        });
      }

      for (const button of body.querySelectorAll('[data-drop]')) {
        // Two presses, the same as everywhere else on these shelves.
        let ready = false;
        const original = button.textContent;
        button.addEventListener('click', async () => {
          if (!ready) {
            ready = true;
            button.textContent = 'Remove?';
            setTimeout(() => {
              ready = false;
              button.textContent = original;
            }, 4000);
            return;
          }
          await api.deleteWorkflow(button.dataset.drop);
          reload();
        });
      }
    },

    onNew: () => openForm(),
  };
}

/**
 * The create-and-edit sheet.
 *
 * Steps are one per line in a textarea rather than a list of inputs with add and
 * remove buttons. Reordering four instructions is something a text editor is
 * already good at, and the row-based version is a great deal of interface to
 * maintain for the same result.
 *
 * It lives here rather than in `pages.js` so the whole feature is one file to
 * read — the shell only has to know how to open it.
 */
export function workflowForm({ toast, reload }) {
  const $ = (id) => document.getElementById(id);
  let editing = null;

  const sheet = () => $('workflow-form');

  async function open(id = null) {
    editing = id;
    let workflow = null;

    if (id) {
      try {
        ({ workflow } = await api.workflow(id));
      } catch (err) {
        toast(err.message);
        return;
      }
    }

    $('workflow-form-title').textContent = workflow ? 'Edit workflow' : 'Create workflow';
    $('workflow-form-name').value = workflow?.title || '';
    $('workflow-form-steps').value = (workflow?.steps || []).map((s) => s.instruction).join('\n');
    $('workflow-form-when').value = workflow?.cron || '';
    $('workflow-form-repeat').value = workflow?.cron ? 'repeat' : 'once';
    $('workflow-form-error').textContent = '';

    sheet().showModal();
    $('workflow-form-name').focus();
  }

  $('workflow-form-save').addEventListener('click', async () => {
    const button = $('workflow-form-save');
    const error = $('workflow-form-error');
    const steps = $('workflow-form-steps')
      .value.split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    // Checked here as well as on the server, because the server's answer to an
    // empty workflow is a 400 and this is a nicer place to hear it.
    if (!steps.length) {
      error.textContent = 'Give it at least one step — one instruction per line.';
      return;
    }

    button.disabled = true;
    try {
      const payload = {
        title: $('workflow-form-name').value.trim(),
        steps,
        when: $('workflow-form-when').value.trim(),
        repeat: $('workflow-form-repeat').value === 'repeat',
      };
      if (editing) await api.updateWorkflow(editing, payload);
      else await api.createWorkflow(payload);

      sheet().close();
      toast(editing ? 'Saved.' : 'Created.');
      reload();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  $('workflow-form-cancel').addEventListener('click', () => sheet().close());

  return { open };
}

export const workflowMark =
  '<svg viewBox="0 0 40 40" width="38" height="38" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="4"/><circle cx="9" cy="31" r="4"/><circle cx="31" cy="20" r="4"/><path d="M13 9h8a4 4 0 0 1 4 4v3M13 31h8a4 4 0 0 0 4-4v-3"/></svg>';
