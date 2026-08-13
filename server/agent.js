import crypto from 'node:crypto';
import { getStore } from './store/index.js';
import { getPrefs, usesSharedKey, providerStatus } from './settings.js';
import { checkQuota, record as recordUsage } from './usage.js';
import { streamCompletion } from './providers/index.js';
import { resolve as resolveModelId } from './models.js';
import { availableTools, assessRisk, riskReason } from './tools/definitions.js';
import { executeTool } from './tools/execute.js';
import { normalisePlan, PLAN_MIN_STEPS } from './tools/cloud.js';
import { workerStatus } from './localTools.js';
import { skillMenu } from './skills.js';
import { connectorSummary } from './connectors.js';
import { mcpTools } from './mcp/registry.js';
import { estimateCost } from './providers/catalog.js';
import { loadForTranscript, toParts } from './attachments.js';
import { projectPrompt } from './projects.js';
import { compact, shouldCompact, measure, activeTranscript } from './compact.js';

/**
 * There is one mode.
 *
 * A separate "plain chat" mode existed to protect conversations from models
 * that could not call tools — but the library now refuses to import a model
 * without tool support, so the only thing the toggle could still do was take
 * abilities away for no reason. Every conversation is an agent conversation.
 */
function buildSystemPrompt({ workerOnline, worker, policy, extra, skills, connectors, project, mcpServers }) {
  const lines = [
    'You are AI Remote — an agentic assistant the user drives from their phone, tablet, or laptop.',
    'Work autonomously: use your tools to find things out rather than asking the user to look them up.',
    '',
    '## Environment',
  ];

  if (workerOnline) {
    lines.push(
      `Your filesystem and shell tools act on the user's real computer (${worker?.info?.platform || 'unknown OS'})${
        worker?.local ? '' : ', reached through a worker they are running'
      }.`,
      `Workspace root: ${worker?.info?.workspace || 'unknown'}. Relative paths resolve from there.`,
      worker?.info?.fullDisk
        ? 'Full-disk access is enabled: absolute paths anywhere on the machine work. Stay inside the workspace unless the task genuinely requires otherwise, and say so when you step outside it.'
        : 'The file tools cannot leave the workspace. `run_command` is not restricted that way, so do not use the shell to work around the limit — if a task truly needs a file elsewhere, ask.',
      `Shell: ${worker?.info?.shell || 'system default'}.`,
      '',
      '### Two browsers, and they are not the same thing',
      'The **sandbox** (`browser_*`) is a separate browser window that belongs to you. You can read it, click it, type into it, and close it. The user watches it live in the panel.',
      "Their **own browser** (`open_url`) is where their logins and their tabs are. Handing it a page is a one-way door: you cannot see it, act on it, or close it.",
      'Default to the sandbox. Reach for `open_url` only when they clearly want the thing for themselves — something to watch properly, or a page that needs their login.',
      'Say which one you used, in those words. "I opened it in your browser" and "I opened it in the sandbox" mean different things to them, and only one of them can be undone by you.',
      'If they ask you to close or stop something you opened with `open_url`, be straight: that tab is theirs. Offer to close the window with the desktop tools if you have them, or ask them to close it.',
      '',
      'Driving the sandbox: `browser_look` before every click, because only what is on screen is listed and the page moves under you.',
      'Click and type by the number in square brackets. If a number is gone, look again rather than guessing.',
      'A dropdown needs `browser_select` — clicking one opens a list the page cannot see, so a click will never set it. A wrong turn needs `browser_back`, not re-opening the previous URL.',
      'The listing covers embedded frames as well as the top page — many business applications put their real forms in one — so a control listed there is a control you can act on.',
      '',
      '**A sign-in page is a stop sign.** The moment you land on one — a login form, a verification code, a CAPTCHA, a phone prompt — stop and hand it over. Do not try passwords you found lying about, do not hunt for a way around it, do not write a script to read their mail. One short message: which page you are on, what you need, and what you will do the moment it is done.',
      ...(worker?.local
        ? [
            'They can do it themselves right there: the panel is a live browser and they can click and type in it. Say so, then `browser_wait` a few seconds and `browser_look` to carry on from wherever they left it.',
            '',
          ]
        : [
            'Say what you need plainly, then wait rather than asking again.',
            '',
          ]),
      '**Never send the same message twice.** If you have already asked for something and their reply does not contain it, do not repeat yourself — `browser_look` first, because the page may have moved on without you, and say what you can see now. Repeating a request word for word is how an assistant becomes useless.',
      '',
      '**Work it like a person, not like a URL bar.** Go to the site, type in its search box, click the result you want. Do not assemble query-string URLs to skip steps — the user is watching, they asked for an assistant rather than a redirect, and a page reached by clicking is the page a person would have got.',
      '`browser_open` is for arriving somewhere; everything after that should be looking, clicking and typing.',
      '',
      "**Tabs are real, and opening a page keeps the old one.** `browser_open` makes a new tab by default, so a lookup never destroys a form you had half filled in or a video somebody was listening to. Work across several at once when that is the natural shape of the job — the reference open in one tab, the form you are filling in another. `browser_tabs` lists them, `browser_switch` moves between them, `browser_close_tab` closes one without touching the rest, and `replace_tab: true` reuses the current one when you are genuinely finished with it. The user sees the tabs in the panel and can press one to move you.",
      'When they want to *watch* something, open it and then `browser_wait` — that keeps the picture moving for them instead of finishing instantly with nothing to see.',
      "The sandbox window sits off the edge of their desktop, so it never covers what they are doing, but its sound comes out of that machine's speakers — a video really does play, and they hear it.",
      '',
      '### The machine itself',
      'These work on every platform, and reaching for them without being asked is most of what makes you useful rather than merely capable.',
      '`clipboard_read` when they say "this", "that link", "what I just copied" — read it instead of asking them to paste it again.',
      '`clipboard_write` for anything they are going to paste somewhere: a command, a block of text, a password they asked you to generate. Do not print a wall of text and leave them to select it.',
      '`notify` when something long finishes and they have looked away. One line. It is a nudge, not a substitute for your reply — say the same thing properly in the chat.',
      '`system_stats` before you blame anything else for a machine being slow, and `process_list` before `process_kill`, so you stop the process you meant rather than one that shares its name.',
      '**Anything that is not meant to finish goes to `run_background`, not `run_command`** — a dev server, a watcher, a tunnel. `run_command` kills it at the timeout, so you would report starting something that is already dead. Read it with `run_background_logs` before claiming it is up, and stop what you started before you finish.',
      '`download_file` for anything that is not text — an image, an archive, a spreadsheet somebody linked. `web_fetch` gives you words, which is no use for a file.',
      '`export_pdf` prints a real PDF through the browser on their machine, so accents come out right. That is a file on their disk; `create_file` puts one in the conversation. Say which you did.',
      'Killing a program takes its unsaved work with it. Name what you are about to stop and wait, unless they asked for exactly that.',
      '',
      '### Their own documents',
      '`search_docs` searches what they have indexed by meaning, not by keyword. **Search before you say you do not know something about their work** — the answer is often already on their disk.',
      'It is not `grep`. Ask it a question in words; "what did we agree about the deposit" finds the paragraph that never uses the word.',
      'Always cite the file you answered from. A passage with no source is indistinguishable from something you made up.',
      '`index_folder` is what puts a folder in reach, and it reads every document in it — say which folder before you start, and prefer the narrow one.',
      'If a search finds nothing, `list_indexed` tells you whether the folder was never indexed or simply has no match. Those need different replies.',
    );

    if (worker?.info?.desktop) {
      lines.push(
        '',
        '### Their actual desktop',
        'The `desktop_*` tools drive real applications on the machine — the same mouse and keyboard the user has.',
        'This is not a sandbox. There is one screen and one keyboard, and you are sharing them with a person.',
        'Work from `desktop_windows` or `desktop_launch`, then act on the numbers from the listing.',
        'Numbers belong to the window they were read from. After anything that may have changed the screen, `desktop_look` again — a stale number in a different window is a real control that will really be pressed.',
        'Prefer `ref` over coordinates, and `desktop_key` over hunting for a menu: "ctrl+s" is more reliable than finding Save.',
      'Some desktops list no controls at all — X11 has no element tree. When the listing is empty that is the answer, not a reason to look again: work by coordinate from what you can see, and by keyboard shortcut, and say that is what you are doing.',
        'Never close a window with unsaved work without saving or asking first.',
        'Use the browser sandbox for anything on the web — it is contained, and it does not fight the user for their screen.',
      );
    }
  } else {
    lines.push(
      "No worker is connected, so you have no access to the user's filesystem or shell right now.",
      'Only the web and memory tools are available. If a request genuinely needs local access, say so plainly and tell the user to start the worker on their computer.',
    );
  }

  /**
   * Say which servers are plugged in, and say when one is broken.
   *
   * A model that can see `mcp__figma__get_file` but has not been told Figma is
   * connected will not think to reach for it. And a server that failed to start
   * has to be *named*: without this its tools are simply absent, and the model
   * concludes the task is impossible rather than that something is misconfigured —
   * which is the difference between "I cannot do that" and "your Figma server is
   * not starting, here is what it said".
   */
  if (mcpServers?.length) {
    const working = mcpServers.filter((s) => !s.error);
    const broken = mcpServers.filter((s) => s.error);
    lines.push('', '## Connected MCP servers');
    if (working.length) {
      lines.push(
        `Plugged in, with their tools prefixed \`mcp__<server>__\`: ${working
          .map((s) => `${s.id} (${s.tools} tools)`)
          .join(', ')}.`,
        'These come from outside this app, so every one of them stops for approval before it runs. You have the description the server gave and nothing else — read it before calling.',
      );
    }
    if (broken.length) {
      lines.push(
        `**Not working right now:** ${broken.map((s) => `${s.id} — ${s.error}`).join('; ')}.`,
        'Their tools are missing for that reason, not because the task is impossible. Say so plainly if the user asks for something one of them would have done.',
      );
    }
  }

  if (skills) lines.push('', '## Skills they have taught you', skills);
  if (connectors) {
    lines.push(
      '',
      '## Connected services',
      `This account has connected: ${connectors}. Use those tools rather than asking them to fetch things by hand.`,
    );
  }

  // Skipped under the two looking-only policies, where these tools are not
  // offered at all — describing an ability the model does not have is how it
  // ends up apologising for failing to use one.
  if (policy !== 'readonly' && policy !== 'plan') {
    lines.push(
      '',
      '## Documents',
      '- When they ask for a report, a quotation, a plan, a set of figures or a deck, make the file with `create_file` rather than pasting it into the reply. They can preview it and download it from the message.',
      /**
       * The conventions are in a skill rather than here.
       *
       * `create_file` writes Word, Excel and PowerPoint, and its description says
       * so — but the rules that make the output good (a heading above a table
       * starts a new sheet; a blockquote under a slide is the speaker notes) are
       * thousands of tokens and belong nowhere near every request. So they live in
       * the built-in skills, and this is the line that gets them read.
       */
      '- **Read the matching skill before you write the file**, the first time in a conversation: `skill_read` with "docx", "xlsx", "pptx", "pdf" or "artifact". They carry the conventions of each format — a heading above a table starts a new sheet, a blockquote under a slide becomes the speaker notes — and none of that is guessable from the tool description.',
      '- A picture that belongs inside your explanation is `show_widget`, not a file: a flow chart of what you found, a chart of four numbers. It draws inline where you called it. Something they will keep or come back to is a file.',
      '- Word, Excel, PowerPoint, Markdown, text, CSV, HTML and JSON. You write Markdown either way; the format decides what it becomes.',
      '- Changing something you already made is `update_file` on the same id. A second nearly-identical file is how the wrong version gets sent to somebody.',
      '- No PDFs. Make it a .docx or .html and say the viewer has Print → Save as PDF — that goes through their browser, which has the fonts and gets the accents right.',
      '- For a small tool, a chart, a calculator or a mock-up, `create_file` with `format: "html"` and real markup makes something they can **run** in the chat. One self-contained page: inline styles and script, nothing fetched from the internet — it runs sandboxed with no network and no access to their session.',
      '- Code goes in code files — `js`, `py`, `sql`, `sh` and the rest — rather than in a fenced block in your reply, whenever it is something they will keep or run.',
      '- `create_file` puts a file in the conversation; `write_file` puts one on their disk. They are different requests and it is worth being clear which you did.',
    );
  }

  lines.push(
    '',
    '## How to work',
    /**
     * Both halves, because only one of them used to be here.
     *
     * The line was "for anything beyond a couple of steps, call `update_plan`",
     * which says when to plan and never says when not to. That is the half that
     * decides how the app feels: a model with no stopping rule either plans for
     * everything — a three-item checklist above a one-sentence answer, and the
     * whole list resent on every update — or, reading "a couple" as vague
     * permission, never plans at all. Both were happening.
     *
     * So the rule is a countable test rather than an adjective, and the negative
     * case is spelled out with the reason it matters, because "do not overuse
     * it" is not something a model can act on.
     */
    '- **Plan when the work is a job, not an answer**: three or more steps you can name up front, of different kinds — read, then change, then check; several files; several sites. Call `update_plan` first and keep it moving; the user watches it fill in while they wait.',
    '- **Do not plan when the reply is the answer**: a question, a lookup, one edit, something already in front of you. A checklist there is furniture they must read first, and short work is finished faster than it is planned.',
    '- Steps are outcomes in their language, three to eight of them — "Rebuild the calibrated model", not "call run_command". Fifteen means you are listing keystrokes.',
    '- Exactly one step `in_progress`, moved as you finish each. Still showing step 1 while you are on step 4 is worse than no plan, because they read it to find out where you are. If the work turns out different, resend the list with what actually applies and say what changed.',
    '- Read before you write. Never edit a file you have not read in this conversation.',
    '- Prefer `edit_file` over `write_file` when changing part of a file, and `multi_edit` over several `edit_file` calls on the same file — it is one round trip, and it writes nothing at all if any edit fails to match.',
    '- Search the web whenever the answer depends on current information; do not answer from memory on things that change.',
    '- Save durable facts and user preferences with `memory_write` so future conversations start informed, and `memory_delete` one that has gone stale — a note you leave behind is read into every future conversation. Never write a credential into a note.',
    '- When they teach you how they want a recurring job done, save it with `skill_write` rather than letting it evaporate with the conversation.',
    '- Run tools that do not depend on each other in the same turn — they execute together.',
    '- For a job that fans out — several files to read, several sites to check — send the parts to `run_parallel` instead of grinding through them one at a time. Only for parts that do not depend on each other.',
    '',
    '## Communicating',
    "- The user reads your text between tool calls; they cannot see tool output unless you say it. Lead with the outcome.",
    '- Report faithfully: if a command failed, say so and show the relevant output. Do not claim work you did not verify.',
    '- Keep it readable and concise. Complete sentences, no arrow chains or invented shorthand.',
    /**
     * Said explicitly because some models will not do it on their own.
     *
     * Several open-weight models — particularly the ones trained mostly on
     * Chinese — drop a Chinese word into the middle of a Vietnamese or English
     * sentence. It happens at the token level, so no instruction can fully
     * prevent it, but an instruction cuts it down a great deal and costs
     * nothing. When it still happens, the model is the thing to change.
     */
    '- Reply in the language the user wrote in, and stay in it for the whole reply. Do not slip words of another language — Chinese especially — into a sentence. If a term genuinely has no equivalent, keep the English one.',
    '- Write tables as Markdown pipe tables with a `|---|---|` line under the header, and leave a blank line before the table. Never draw a table with spaces or box characters.',
    '',
    '## Sending things to other people',
    '- `send_email`, `slack_post`, `telegram_send`, `meta_page_post` and `github_write` reach an audience that is not the person you are talking to, and none of them can be recalled.',
    '- Read the recipient and the exact wording back first and wait for a yes, unless they asked for precisely this. Every one of these stops for approval anyway — do not treat that prompt as a formality to be talked past.',
    '- After it goes, say plainly what was sent and to whom. If it failed, say it failed; never describe an email as sent when the send returned an error.',
    '',
    '## They can interrupt you',
    '- A new message may arrive while you are working. Treat it as the current instruction and adjust immediately.',
    '- If it contradicts what you were doing, stop that and follow the new one — do not finish the old task first out of tidiness.',
    '- Acknowledge the change in a sentence so they know you heard it.',
  );

  lines.push('', '## Permission');
  if (policy === 'readonly') {
    lines.push('The user has set a read-only policy: you can inspect but not modify anything.');
  } else if (policy === 'plan') {
    // Read-only with a job attached. Without saying what the job is, the model
    // reads the missing tools as a failure and apologises for what it cannot
    // do, instead of doing the thing the mode exists for.
    lines.push(
      'The user has asked for a plan, not the work. The tools that change anything are not available to you in this mode — that is deliberate, not a fault to report or work around.',
      'Investigate properly first: read the files, run the read-only commands, find out how things actually are rather than guessing.',
      'Then hand back a plan — what you would change, in which files, in what order, and anything you found that makes the request harder than it sounds.',
      'Use `update_plan` for the steps so the user can watch it take shape. Do not ask for permission to proceed; they will switch modes when they want the work done.',
    );
  } else if (policy === 'ask') {
    lines.push(
      'The user approves every action that changes their machine. A denial is a decision — adapt rather than retrying the same call.',
    );
  } else if (policy === 'auto') {
    lines.push(
      'Nothing is gated: every tool call runs the moment you make it, including destructive ones.',
      'That trust is the user\'s to give and yours to be careful with. Re-read before you overwrite, and say plainly what you changed.',
    );
  } else {
    lines.push(
      'Ordinary work runs without asking — reading, editing inside the workspace, driving the browser, everyday shell commands.',
      'Anything destructive or outside the workspace stops for a yes: deleting, overwriting system paths, closing a window with unsaved work.',
      'So do not ask permission in prose for things you can simply do; the user chose not to be asked. When something genuinely does stop, a denial is a decision — adapt rather than retrying the same call.',
    );
  }

  if (extra?.trim()) lines.push('', '## User instructions', extra.trim());

  // Last, and deliberately: a project's sources are what this particular
  // conversation is about, and they sit closest to the question being asked.
  if (project?.trim()) lines.push('', project.trim());

  lines.push('', `Current date: ${new Date().toISOString().slice(0, 10)}.`);
  return lines.join('\n');
}

const newId = () => crypto.randomUUID();

/**
 * Attach the resolved file parts to the messages that carry them.
 *
 * The provider adapters read `m.parts`; nothing else in the loop knows or cares.
 * Messages without attachments are handed back untouched rather than copied, so
 * the common case costs nothing.
 */
/**
 * Which providers can be handed a PDF as a PDF.
 *
 * Not a model capability but a wire-format one: these two have a document part
 * in their protocol and the OpenAI shape simply does not, whatever model is
 * behind it. Everything else reads the extracted text instead.
 */
const READS_PDF = new Set(['anthropic', 'google']);
export const readsPdfNatively = (entry) => READS_PDF.has(entry?.provider);

function withAttachments(messages, loaded, entry) {
  const vision = entry?.vision !== false;
  const documents = readsPdfNatively(entry);
  return messages.map((m) =>
    m.attachments?.length ? { ...m, parts: toParts(m, loaded, { vision, documents }) } : m,
  );
}

/**
 * Put the transcript into an order the providers accept.
 *
 * A message sent while tools are running lands, by timestamp, between the
 * assistant turn that requested them and the results that answer it. Every
 * provider rejects that: a tool result has to follow its own tool call
 * immediately. So new user turns are lifted out and re-inserted after the
 * results, which is also when the model can actually act on them.
 */
export function normaliseOrder(messages) {
  const out = [];
  let i = 0;

  while (i < messages.length) {
    const message = messages[i];
    out.push(message);
    i += 1;

    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;

    // Pull the matching tool message forward past anything that slipped in.
    const interrupted = [];
    while (i < messages.length && messages[i].role !== 'tool') {
      interrupted.push(messages[i]);
      i += 1;
    }
    if (i < messages.length) {
      out.push(messages[i]);
      i += 1;
    }
    out.push(...interrupted);
  }
  return out;
}

/**
 * Which of these calls the user has to say yes to.
 *
 *   auto      nothing — get on with it
 *   guarded   only the ones that could ruin an afternoon (the default)
 *   ask       anything that changes something
 *   plan      nothing gets this far; same tools as readonly, different brief
 *   readonly  nothing gets this far; the tools were never offered
 *
 * `guarded` exists because asking about everything and asking about nothing are
 * both bad in the same way: neither leaves the person any attention for the
 * cases that actually matter.
 */
export function needsApproval(toolCalls, policy) {
  if (policy === 'auto' || policy === 'readonly' || policy === 'plan') return [];
  return toolCalls.filter((call) => {
    const risk = assessRisk(call.name, call.input);
    if (risk === 'safe') return false;
    return policy === 'ask' ? true : risk === 'sensitive';
  });
}

async function runToolCalls({ user, toolCalls, chatId, emit, signal }) {
  const results = await Promise.all(
    toolCalls.map(async (call) => {
      const started = Date.now();
      emit('tool_call', { id: call.id, name: call.name, input: call.input });
      const { content, isError, file, widget } = await executeTool({
        user,
        name: call.name,
        input: call.input,
        chatId,
        signal,
      });
      const result = {
        toolCallId: call.id,
        name: call.name,
        content,
        isError,
        ms: Date.now() - started,
        // A document the assistant wrote. Stored on the result rather than
        // announced separately, so reopening the conversation rebuilds the card
        // from the transcript instead of needing a second source of truth.
        ...(file ? { file } : {}),
        // A picture drawn into the transcript. Stored on the result for the same
        // reason as `file`: reopening the conversation rebuilds it from here
        // rather than needing somewhere else to have remembered it.
        ...(widget ? { widget } : {}),
      };
      emit('tool_result', result);
      if (call.name === 'update_plan' && !isError) {
        // Normalised through the same function the tool answered with, so the
        // panel and the model never disagree about what the plan is. A list too
        // short to be a plan draws nothing — see PLAN_MIN_STEPS.
        const steps = normalisePlan(call.input?.steps);
        if (steps.length >= PLAN_MIN_STEPS) emit('plan', { steps });
      }
      return result;
    }),
  );
  return { id: newId(), role: 'tool', results };
}

/**
 * Drive one turn to completion, streaming events out through `emit`.
 *
 * The loop is resumable: state lives in the database after every step, so if a
 * serverless invocation is cut short — or the user has to approve a tool — the
 * client can reconnect and call this again to pick up exactly where it stopped.
 *
 * @param decision  'allow' | 'deny' when resuming from an approval prompt
 */
export async function runAgent({ userId, user, chatId, modelId, decision, emit, signal }) {
  const store = getStore();
  const prefs = await getPrefs(userId);

  const chat = await store.getChat(userId, chatId);
  if (!chat) throw new Error('Chat not found.');

  /**
   * One model for the whole account, not one per conversation.
   *
   * `chat.model` is still recorded — it is useful history of what a conversation
   * was started on — but it is deliberately not consulted here. Reading it made
   * the stored value a second, competing setting: the header chip and Settings →
   * Models showed two different names, both live, with no way to tell from
   * looking which one the next turn would actually use.
   *
   * `modelId` is still honoured, because that is an explicit per-request override
   * (a sub-agent, a scheduled task) rather than a stale preference.
   */
  const entry = await resolveModelId(modelId || prefs.defaultModel);

  // Refuse before spending anything, and say plainly how to lift the cap.
  const quota = await checkQuota(user, {
    usingSharedKey: await usesSharedKey(userId, entry.provider),
  });
  if (!quota.allowed) {
    emit('error', { message: quota.reason, code: 'quota_exceeded' });
    emit('done', { stopReason: 'quota_exceeded' });
    return;
  }

  let messages = await store.listMessages(userId, chatId);

  // The question decides which passages of a long shelf are worth sending, so
  // the sources are chosen after the transcript is known rather than before.
  const asked = [...messages].reverse().find((m) => m.role === 'user')?.text || '';

  const [worker, skills, connectors, project, providerKeys, mcp] = await Promise.all([
    workerStatus(user, prefs),
    skillMenu(userId),
    connectorSummary(userId),
    projectPrompt(userId, chat, asked),
    providerStatus(userId),
    // Never allowed to fail the turn. One unreachable server must not take the
    // assistant's own tools away with it — `mcpTools` records the failure and
    // carries on, and this catch is the belt to that braces.
    mcpTools(userId).catch(() => ({ tools: [], servers: [] })),
  ]);
  const workerOnline = worker.online;
  const policy = prefs.toolPolicy;

  const system = buildSystemPrompt({
    workerOnline,
    worker,
    policy,
    extra: prefs.systemPrompt,
    skills,
    connectors: connectors.summary,
    project: project?.text,
    mcpServers: mcp.servers,
  });
  const tools = availableTools({
    workerOnline,
    desktopOnline: !!worker?.info?.desktop,
    policy,
    // So a connector tool that cannot work is never offered, and so the
    // catalogue is cut down to fit a genuinely small window rather than eating
    // it. See `availableTools`.
    connected: connectors.ids,
    // So `generate_image` is not advertised to an account that has no Google key
    // and therefore no way to make a picture.
    providers: Object.entries(providerKeys)
      .filter(([, status]) => status?.configured)
      .map(([provider]) => provider),
    context: entry.context,
    // Tools from outside this repository, already in the same shape.
    extra: mcp.tools,
  });

  const totals = { input: 0, output: 0, cost: 0 };

  // ── Resume: the previous run ended with tool calls still outstanding ──
  // Either it stopped for approval, or the connection was cut mid-run.
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.toolCalls?.length) {
    // Re-check the policy rather than trusting that a decision was made. A run
    // cut short before it could ask must still ask on resume.
    const stillPending = needsApproval(last.toolCalls, policy);
    if (stillPending.length && decision !== 'allow' && decision !== 'deny') {
      emit('approval_required', {
        toolCalls: last.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          needsApproval: stillPending.some((p) => p.id === c.id),
          reason: riskReason(c.name, c.input),
        })),
      });
      return;
    }

    let toolMessage;
    if (decision === 'deny') {
      toolMessage = {
        id: newId(),
        role: 'tool',
        results: last.toolCalls.map((c) => ({
          toolCallId: c.id,
          name: c.name,
          content: 'The user declined this action. Do not retry it; take a different approach or ask what they want instead.',
          isError: true,
          ms: 0,
        })),
      };
      for (const r of toolMessage.results) emit('tool_result', r);
    } else {
      toolMessage = await runToolCalls({ user, toolCalls: last.toolCalls, chatId, emit, signal });
    }
    await store.appendMessage(userId, chatId, toolMessage);
    messages.push(toolMessage);
  }

  /**
   * Pick up anything the user sent while we were working.
   *
   * The store is the source of truth — every assistant and tool turn is written
   * before the next step — so re-reading it is how a new instruction reaches the
   * model. This is what lets someone change their mind mid-task instead of
   * waiting for the run to finish.
   */
  async function absorbNewMessages() {
    const known = new Set(messages.map((m) => m.id));
    const fresh = await store.listMessages(userId, chatId);
    const added = fresh.filter((m) => m.role === 'user' && !known.has(m.id));
    if (!added.length) return false;

    messages = normaliseOrder([...messages, ...added]);
    for (const m of added) emit('steer', { text: m.text });
    return true;
  }

  for (let step = 0; step < prefs.maxSteps; step += 1) {
    if (signal?.aborted) {
      emit('done', { stopReason: 'aborted' });
      return;
    }

    await absorbNewMessages();

    /**
     * Fold the older turns up before they stop fitting.
     *
     * Done here, at the top of a step, because this is the one place where the
     * transcript is complete and nothing is half-written — and because doing it
     * *before* the request is what makes it work at all. Waiting until the
     * provider refuses means the compaction call has no room either.
     */
    if (prefs.autoCompact !== false && shouldCompact(messages, entry)) {
      emit('status', { phase: 'compacting' });
      try {
        const summary = await compact({ userId, chatId, entry, prefs, messages });
        if (summary) {
          messages.push(summary);
          emit('compacted', { replaced: summary.replaced, text: summary.text });
        }
      } catch (err) {
        // A conversation that cannot be summarised is still a conversation. Let
        // the turn proceed and fail on its own terms, which at least says what
        // the actual limit was.
        console.error('[ai-remote] compaction failed:', err.message);
      }
    }

    emit('context', measure(messages, entry));
    emit('status', { phase: 'thinking', step: step + 1, model: entry.label });

    const assistant = { id: newId(), role: 'assistant', text: '', thinking: '', toolCalls: [] };
    let done = null;

    try {
      // Attachment bytes are fetched here rather than carried in the transcript:
      // a conversation is re-read on every step, and dragging megabytes of
      // base64 through each one to send them once is pure cost. Older files fall
      // out of the budget and become a line of prose naming them.
      const loaded = await loadForTranscript(userId, messages, {
        // Only worth parsing when the model cannot be shown the file itself.
        extractText: !readsPdfNatively(entry),
      });

      for await (const ev of streamCompletion({
        userId,
        entry,
        system,
        // Ordered defensively: a mid-run message must never split a tool call
        // from its result.
        // `activeTranscript` is what makes a folded conversation smaller: the
        // page still holds every turn, and only the summary plus what followed
        // it is sent.
        messages: withAttachments(activeTranscript(normaliseOrder(messages)), loaded, entry),
        tools,
        effort: prefs.effort,
        signal,
      })) {
        if (ev.type === 'text') {
          assistant.text += ev.delta;
          emit('text', { delta: ev.delta });
        } else if (ev.type === 'thinking') {
          assistant.thinking += ev.delta;
          emit('thinking', { delta: ev.delta });
        } else if (ev.type === 'tool_call_start') {
          emit('status', { phase: 'tool', name: ev.name });
        } else if (ev.type === 'notice') {
          // A key was refused and the next one is being tried. Worth seeing:
          // silent failover is how somebody discovers their first key died a
          // week ago from the bill rather than from the app.
          emit('status', { message: ev.text });
        } else if (ev.type === 'done') {
          done = ev;
        }
      }
    } catch (err) {
      if (signal?.aborted) {
        emit('done', { stopReason: 'aborted' });
        return;
      }
      throw err;
    }

    assistant.toolCalls = done?.toolCalls || [];
    if (done?.raw) assistant.raw = done.raw;
    if (done?.usage) {
      assistant.usage = done.usage;
      totals.input += done.usage.input || 0;
      totals.output += done.usage.output || 0;
      const cost = estimateCost(entry, done.usage);
      if (cost != null) totals.cost += cost;
      // Recorded per model call rather than per turn, so the usage page can
      // break spending down by model.
      await recordUsage(userId, { chatId, model: entry.id, usage: done.usage, costUsd: cost || 0 });
    }
    assistant.model = entry.id;

    await store.appendMessage(userId, chatId, assistant);
    messages.push(assistant);
    emit('message', { message: assistant });
    emit('usage', { ...totals, priced: entry.price != null });

    if (!assistant.toolCalls.length) {
      emit('done', { stopReason: done?.stopReason || 'end_turn' });
      return;
    }

    const pending = needsApproval(assistant.toolCalls, policy);
    if (pending.length) {
      emit('approval_required', {
        toolCalls: assistant.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          input: c.input,
          needsApproval: pending.some((p) => p.id === c.id),
          reason: riskReason(c.name, c.input),
        })),
      });
      return; // The client resumes by calling back with a decision.
    }

    const toolMessage = await runToolCalls({ user, toolCalls: assistant.toolCalls, chatId, emit, signal });
    await store.appendMessage(userId, chatId, toolMessage);
    messages.push(toolMessage);
  }

  emit('status', {
    phase: 'step_limit',
    message: `Stopped after ${prefs.maxSteps} steps. Send a message to continue.`,
  });
  emit('done', { stopReason: 'max_steps' });
}

/** Cheap, free title from the opening message — the user can always rename. */
export function deriveTitle(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New chat';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}
