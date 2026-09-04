/**
 * English.
 *
 * The keys here are the same set as `vi.js`, and they have to stay that way —
 * `test/i18n.test.mjs` fails the build if either side gains a key the other does
 * not have, because a half-translated screen is the failure mode that hides.
 */
export const en = {
  /* ── shared ────────────────────────────────────────────────────── */
  'app.name': 'AI Remote',
  'action.next': 'Continue',
  'action.back': 'Back',
  'action.skip': 'Skip',
  'action.done': 'Start using it',
  'action.close': 'Close',
  'action.save': 'Save',
  'action.cancel': 'Cancel',
  'action.change': 'Change',

  /* ── sidebar ───────────────────────────────────────────────────── */
  'nav.newChat': 'New chat',
  'nav.search': 'Search conversations',
  'nav.projects': 'Projects',
  'nav.artifacts': 'Artifacts',
  'nav.scheduled': 'Scheduled',
  'nav.workflows': 'Workflows',
  'nav.workspace': 'Workspace',
  'nav.settings': 'Settings',
  'nav.conversations': 'CONVERSATIONS',

  /* ── topbar & composer ─────────────────────────────────────────── */
  'topbar.computers': 'Computers',
  'topbar.panel': 'Progress and screen',
  'composer.placeholder': 'Ask anything…  (Enter to send, Shift+Enter for a new line)',
  // While a turn is running the box does something different, so it says so.
  // Sending here queues: the message waits, visibly, and goes in at the next
  // step boundary rather than starting a second conversation over the first.
  'composer.placeholderRunning': 'Queue another message…',
  'composer.attach': 'Attach photos or files',
  'composer.send': 'Send',
  'composer.queue': 'Queue this — it goes in at the next step',
  'composer.stop': 'Stop',
  'composer.stopped': 'Stopped.',
  // Shown in the tab that is watching rather than driving — see mirror.js.
  'mirror.watching': 'Running in another tab — watching…',
  /* What the assistant is doing, in the line above the composer. */
  'status.thinking': 'Thinking…',
  'status.compacting': 'Summarising the earlier turns…',
  'status.tool': 'Running {name}…',
  // Not the same thing as thinking, and the difference is the point: the
  // provider has not started answering. The count moves, because a number that
  // moves is what separates waiting from wondering.
  'status.waiting': 'Waiting for {model} to start — {n}s',
  'status.waitingFree': 'Waiting for {model} — free models queue when busy ({n}s). Switch model if this drags.',

  /* ── why a reply stopped ─────────────────────────────────────────
   *
   * Only ever shown when the reply is *not* a finished answer. Three of these
   * used to end a turn looking exactly like a complete one: the stream stops,
   * the spinner clears, and the last paragraph simply has no end. Saying which
   * of them happened is the difference between "the assistant answered" and
   * "the assistant was cut off" — and only one of those is worth acting on.
   */
  'stop.truncated':
    'Cut off — the reply hit this model’s maximum output length. Ask it to continue, or pick a model with a larger output limit.',
  'stop.refused':
    'The provider’s safety system declined this request, so the model produced nothing. Rephrasing, or a different model, is the way on.',
  'stop.filtered':
    'The provider’s content filter blocked this reply. What you can see is only the part that got through.',
  'stop.recitation':
    'Stopped because the answer was reproducing source material too closely. Ask for it in your own words and it will usually go through.',
  'stop.unknown': 'The provider ended this reply for a reason it did not explain.',

  // The run has stopped and is waiting on a person — see the alertdialog in
  // index.html. It was the one heading in the composer never translated.
  'approval.title': 'Approve these actions?',
  // The accessible name of the main composer. Not a placeholder — see index.html.
  'composer.label': 'Message',

  /* ── the transcript itself ───────────────────────────────────────
   *
   * These are on the path a user walks every single turn — the reasoning fold,
   * a tool card's output, the buttons on a document — and every one of them was
   * hard-coded English while the language switch sat in Settings claiming
   * otherwise.
   */
  'chat.reasoning': 'Reasoning',
  'chat.noOutput': '(no output)',
  'chat.noResult': '(no result recorded)',
  'chat.diagram': 'Diagram',
  'chat.open': 'Open',
  'chat.download': 'Download',
  'chat.openNamed': 'Open {name}',
  'chat.copy': 'Copy',
  'chat.edit': 'Edit',
  'chat.summaryFold': 'Read the summary',
  'chat.compacted': '{n} earlier messages summarised to free up room',
  'chat.compactedOne': '1 earlier message summarised to free up room',

  /* ── things said while a turn runs ───────────────────────────── */
  'status.reconnecting': 'Reconnecting…',
  'status.restarting': 'Starting that reply again…',
  'status.paused': 'Paused after many resumes. Send a message to carry on.',
  'status.streamFailed': 'The stream failed.',
  'status.queued': 'Sent — it will pick this up at the next step.',
  'status.pickedUp': 'Picked up: "{text}"',
  'status.folded': 'Folded {n} earlier messages into a summary to free up room.',
  'usage.tokens': '{n} tokens',
  'usage.thisTurn': 'this turn',
  'usage.cached': '{n}% cached',
  /* ── the mode chip, beside Send ──────────────────────────────────
   *
   * Five modes and the sentence explaining each. This sits next to the send
   * button — the most-looked-at control in the app — and was English on every
   * account whatever language they had chosen.
   */
  'policy.guarded.label': 'Guarded',
  'policy.ask.label': 'Ask first',
  'policy.auto.label': 'Auto-run',
  'policy.plan.label': 'Plan',
  'policy.readonly.label': 'Read-only',
  'policy.guarded.hint':
    'Reading, editing inside your workspace, driving the browser and everyday commands all run straight away. ' +
    'Deleting, writing outside the workspace, touching Windows system paths and closing unsaved windows stop and ask. ' +
    'That check is a list of known-dangerous patterns, not a sandbox — something destructive it does not recognise will run.',
  'policy.auto.hint': 'Nothing is gated, including destructive actions. Fastest, and the one that can lose work.',
  'policy.ask.hint': 'Every change waits for you. Safest, and the most interrupting — expect to be asked a lot.',
  'policy.plan.hint': 'Explores and reads, then hands back a plan instead of doing the work. Nothing on your machine changes.',
  'policy.readonly.hint': 'The assistant can look at things but the tools that change anything are never even offered to it.',

  /* How hard the model is asked to think, five steps from cheap to careful. */
  'effort.low': 'Low',
  'effort.medium': 'Medium',
  'effort.high': 'High',
  'effort.xhigh': 'Extra high',
  'effort.max': 'Max',
  /* ── the shelves: Projects, Artifacts, Scheduled ─────────────────
   *
   * Four whole screens that called t() zero times. The dictionaries were in
   * sync the entire time, which is exactly why test:i18n never noticed.
   */
  'pages.projects.title': 'Projects',
  'pages.projects.new': 'New project',
  'pages.sortBy': 'Sort by',
  'pages.filterBy': 'Filter by',
  'pages.order.updated': 'Last updated',
  'pages.order.created': 'Date created',
  'pages.order.name': 'Name',
  'pages.order.archived': 'Archived',
  'pages.projects.noneMatch': 'No project matches that.',
  'pages.projects.none': 'No projects yet.',
  'pages.projects.noneHint':
    'A project keeps its instructions and its documents in one place, and every conversation started inside it answers from those documents.',
  'pages.projects.archivedNoneMatch': 'No archived project matches that.',
  'pages.projects.archivedNone': 'Nothing archived.',
  'pages.pinned': 'Pinned',
  'pages.optionsFor': 'Options for {name}',

  'pages.artifacts.title': 'Artifacts',
  'pages.artifacts.new': 'New artifact',
  'pages.artifacts.none': 'No artifacts yet.',
  'pages.artifacts.noneMatch': 'Nothing here matches.',
  'pages.artifacts.newHint': 'Ask for what you want made — a report, a spreadsheet, a small page.',
  'pages.kind.all': 'All',
  'pages.kind.page': 'Pages',
  'pages.kind.code': 'Code',
  'pages.kind.document': 'Documents',
  'pages.kind.sheet': 'Spreadsheets',
  'pages.kind.deck': 'Decks',

  'pages.tasks.title': 'Scheduled tasks',
  'pages.tasks.new': 'New task',
  'pages.tasks.none': 'No scheduled tasks yet.',
  'pages.order.next': 'Next run',
  'pages.tasks.describe': 'Describe it to the assistant',
  'pages.tasks.describeHint': 'Tell it what to run and when — "every weekday at 8, search for…"',
  'pages.tasks.manual': 'Set up manually',
  'pages.tasks.scheduled': 'Scheduled.',
  'pages.tasks.openResult': 'Open result',
  'pages.tasks.pause': 'Pause',
  'pages.tasks.resume': 'Resume',
  'pages.tasks.remove': 'Remove',
  'pages.tasks.removeConfirm': 'Remove?',
  'pages.tasks.every': 'every {cron}',
  'pages.tasks.once': 'once',
  'pages.tasks.next': 'next {when}',
  'pages.tasks.paused': 'paused',
  'pages.tasks.last': 'last {status}',

  /* The four starting points offered on an empty Scheduled shelf. */
  'pages.idea.briefing.name': 'Morning briefing',
  'pages.idea.briefing.what': 'What changed overnight in the things you follow, searched and summarised.',
  'pages.idea.briefing.when': 'Weekdays at 08:00',
  'pages.idea.watch.name': 'Watch a topic',
  'pages.idea.watch.what': 'Check for news about something, and only speak up when there is any.',
  'pages.idea.watch.when': 'Daily at 09:00',
  'pages.idea.report.name': 'Weekly report',
  'pages.idea.report.what': 'A Word document summarising the week, made and left in the conversation.',
  'pages.idea.report.when': 'Fridays at 16:00',
  'pages.idea.tests.name': 'Check the workspace',
  'pages.idea.tests.what': 'Run the tests on your machine and report what failed.',
  'pages.idea.tests.when': 'Weekdays at 09:00',
  /* Relative time, and the two counts on a project card. Vietnamese does not
     inflect the noun, so these are whole phrases rather than a stem plus an
     's' — which is also why `plural()` could not simply be translated. */
  'when.justNow': 'just now',
  'when.minutes': '{n} minutes ago',
  'when.hours': '{n} hours ago',
  'when.yesterday': 'yesterday',
  'when.days': '{n} days ago',
  'count.sources': '{n} sources',
  'count.sourcesOne': '1 source',
  'count.conversations': '{n} conversations',
  'count.conversationsOne': '1 conversation',
  'count.messages': '{n} messages',
  'count.messagesOne': '1 message',
  'count.pages': '{n} pages',
  'count.pagesOne': '1 page',
  'pages.tasks.localOnly':
    'Scheduled tasks run while this app is running. On a deployment they run without it.',
  /* ── workflows ───────────────────────────────────────────────── */
  'wf.title': 'Workflows',
  'wf.new': 'New workflow',
  'wf.order.recent': 'Recently added',
  'wf.describe': 'Describe it to the assistant',
  'wf.describeHint':
    'Say the steps in order — "every Monday: pull the numbers, chart them, email the team".',
  'wf.manual': 'Set up manually',
  'wf.none': 'No workflows yet.',
  'wf.noneHint':
    'Use one when a job has stages that must happen in order — and when repeating a stage by accident would be a problem. A single instruction is a scheduled task instead.',
  'wf.pause': 'Pause',
  'wf.resume': 'Resume',
  'wf.remove': 'Remove',
  'wf.removeConfirm': 'Remove?',
  'wf.runNow': 'Run now',
  'wf.running': 'Running…',
  'wf.finished': 'Finished.',
  'wf.startedBackground': 'Started — it will carry on in the background.',
  'wf.openResult': 'Open result',
  'wf.edit': 'Edit',
  'wf.paused': 'paused',
  'wf.lastRun': 'last run {status}',
  'wf.neverRun': 'never run',
  'wf.formEdit': 'Edit workflow',
  'wf.formCreate': 'Create workflow',
  'wf.needStep': 'Give it at least one step — one instruction per line.',
  'wf.saved': 'Saved.',
  'wf.created': 'Created.',

  /* ── the model browser ───────────────────────────────────────── */
  'models.allVendors': 'All vendors',
  'models.empty': 'Library is empty — press Refresh to pull it from OpenRouter.',
  'models.noMatch': 'Nothing matched. Try fewer words, or add the model by id in Settings → Models.',
  'models.builtIn': 'Built in — your own provider keys',
  'models.onYourKey': '{provider} — on your own key',
  'models.refreshing': 'Refreshing…',
  'models.refreshNow': 'Refresh now',
  'models.automatic': 'Automatic',
  'models.autoName': 'Auto — best free model',
  'models.autoMeta':
    'Picks the strongest free model you can run right now. Image support is a toggle in Settings → Behaviour.',

  /* ── the workspace file list and editor ──────────────────────── */
  'ws.deleteConfirm': 'Delete?',
  'ws.renamePrompt': 'Rename or move — edit the path:',
  'ws.moved': 'Moved.',
  'ws.deleted': 'Deleted.',
  'ws.leaveUnsaved': 'Leave without saving?',
  'ws.saving': 'Saving…',
  'ws.saved': 'Saved.',
  'ws.newFilePrompt': 'New file — name it, with a path if you want a folder:',
  /* ── the project page ────────────────────────────────────────── */
  'proj.pin': 'Pin',
  'proj.unpin': 'Unpin',
  'proj.pinned': 'Pinned to the top.',
  'proj.unpinned': 'Unpinned.',
  'proj.pinAria': 'Pin project',
  'proj.unpinAria': 'Unpin project',
  'proj.editDetails': 'Edit details',
  'proj.archive': 'Archive',
  'proj.restore': 'Restore',
  'proj.archived': 'Archived. It is on the archived shelf, with everything still in it.',
  'proj.restored': 'Back on the shelf.',
  'proj.delete': 'Delete',
  'proj.deleted': 'Deleted.',
  'proj.answersFrom': 'Answers from {sources}',
  'proj.answersFirstFrom': 'Answers first from {sources}',
  'proj.noSources': 'No sources yet — answers like any other chat',
  'proj.untitled': 'Untitled',
  'proj.editInstructions': 'Edit instructions',
  'proj.instructionsSaved': 'Instructions saved.',
  'proj.uploadFromDevice': 'Upload from device',
  'proj.addTextContent': 'Add text content',
  'proj.nothingToAdd': 'There is nothing to add.',
  'proj.pastedText': 'Pasted text',
  'proj.added': 'Added.',
  'proj.addedSources': 'Added {sources}.',
  'proj.fallbackName': 'Project',

  /* ── the artifact viewer ─────────────────────────────────────── */
  'viewer.noStorage': 'This frame has no storage.',
  'viewer.markdownNote': 'Markdown for documents, the file itself for code.',
  'viewer.versionNote': 'An earlier version, shown as it was. Restore it to edit.',
  'viewer.unreadable': 'This file could not be read.',
  'viewer.tab.preview': 'Preview',
  'viewer.tab.code': 'Code',
  'viewer.tab.source': 'Source',
  'viewer.kind.sheets': 'Sheets',
  'viewer.kind.slides': 'Slides',
  'viewer.kind.pages': 'Pages',
  'viewer.kind.document': 'Document',
  'viewer.open': 'Open',
  'viewer.openIn': 'Open in {app}',
  'viewer.openInDefault': 'Open in the default app',
  'viewer.copy': 'Copy',
  'viewer.download': 'Download',
  'viewer.showInFolder': 'Show in folder',
  'viewer.copyPicture': 'Copy picture',
  'viewer.copyFormatted': 'Copy with formatting',
  'viewer.print': 'Print — or save as PDF',
  'viewer.noComputer': 'No computer connected',
  'viewer.noComputerHint':
    'Pair a computer to open files in Word, Excel or a folder. The header chip does it.',
  'viewer.nothingToCopy': 'There is nothing in this one to copy.',
  'viewer.copiedRich': 'Copied — paste into Word and it keeps its formatting.',
  'viewer.copied': 'Copied.',
  'viewer.copyRefused': 'The browser would not allow copying. Press Ctrl/⌘+C instead.',
  'viewer.pictureCopied': 'Picture copied.',
  'viewer.pictureCopyRefused': 'The browser would not allow copying the picture. Download it instead.',
  'viewer.saving': 'Saving…',
  'viewer.backToPanel': 'Back to the panel',
  'viewer.fullSize': 'Full size',
  'viewer.opening': 'Opening…',
  'viewer.couldNotOpen': 'That file could not be opened.',

  /* ── the live screen panel ───────────────────────────────────── */
  'screen.title': 'Screen',
  'screen.wholeMachine': 'The whole screen of the machine running the worker.',
  'screen.sandboxClosed': 'Sandbox closed.',
  'screen.driveOn': 'Stop controlling the page (or press Escape)',
  'screen.driveOff': 'Take control — click and type into the page yourself',
  'screen.close': 'Close the sandbox browser',
  'screen.expand': 'Full size',
  'screen.hide': 'Hide',
  'ws.renameAria': 'Rename {name}',
  'ws.deleteAria': 'Delete {name}',
  'ws.renameTitle': 'Rename or move',
  'proj.memoryScope': 'Memory is stored per account, not per project.',
  'proj.accountWide': 'account-wide',
  'proj.addContext': 'Add context',
  'proj.removeAria': 'Remove {name}',
  'proj.needName': 'A project needs a name.',
  // `\n` as an escape, not a real line break: this goes into `window.confirm`,
  // where the blank line is what separates the question from its consequence.
  'proj.deleteConfirm':
    'Delete “{name}”?\n\nIts sources go with it. The conversations started in it are kept — they return to the ordinary list.',
  'count.chars': '{n} chars',
  'count.charsK': '{n}K chars',
  'count.charsM': '{n}M chars',
  'screen.sandboxNote': 'The assistant’s own browser window — separate from the browser you are using.',





  // The checklist drawn inside a message by `update_plan`, and the count beside
  // the same steps in the progress rail.
  'chat.plan': 'Plan',

  /* ── a run of steps ──────────────────────────────────────────────
   *
   * The verbs a run of browser or desktop actions is drawn with. Written as
   * what happened rather than what was called: `browser_click {"ref":"7"}` is
   * complete and unreadable at the speed the steps go past.
   */
  'steps.browser': 'Used the browser',
  'steps.desktop': 'Used the desktop',
  'steps.count': '{n} steps',
  'step.output': 'Output',
  'step.seconds': '{n} seconds',
  'step.browser.open': 'Opened',
  'step.browser.tabs': 'Listed the tabs',
  'step.browser.switchTab': 'Switched to tab',
  'step.browser.closeTab': 'Closed tab',
  'step.browser.look': 'Read the page',
  'step.browser.click': 'Clicked',
  'step.browser.type': 'Typed',
  'step.browser.press': 'Pressed',
  'step.browser.back': 'Went back',
  'step.browser.forward': 'Went forward',
  'step.browser.select': 'Chose',
  'step.browser.hover': 'Hovered over',
  'step.browser.scroll': 'Scrolled',
  'step.browser.wait': 'Waited',
  'step.browser.close': 'Closed the browser',
  'step.desktop.windows': 'Listed the windows',
  'step.desktop.launch': 'Opened',
  'step.desktop.look': 'Looked at the screen',
  'step.desktop.focus': 'Switched to',
  'step.desktop.click': 'Clicked',
  'step.desktop.type': 'Typed',
  'step.desktop.key': 'Pressed',
  'step.desktop.scroll': 'Scrolled',
  'step.desktop.wait': 'Waited',
  'step.desktop.close': 'Closed',

  /* ── connecting a computer ───────────────────────────────────────── */
  'worker.copy': 'Copy',
  'worker.copied': 'Copied',

  /**
   * The warning is not decoration. A setup token travels toward a machine, so it
   * can be handed to somebody who was told it does something else — and saying
   * so plainly is the only defence. The installer repeats it with the account
   * named and will not continue without a typed YES.
   */
  'setup.warning':
    'This gives whoever runs it full access to that computer — its files, a shell, and control of the screen. Only run it on a computer you own, and never paste a line somebody else sent you.',
  'setup.expires': 'Good for {n} minutes, and only once.',

  /* ── which computer the assistant works on ────────────────────────── */
  'devices.followsYou': 'The assistant works on the computer you have this open on.',
  'devices.pinned': 'Pinned to one computer, whichever you are sitting at.',
  'devices.unpin': 'Follow me instead',
  'devices.unpinned': 'It will use the computer you are on.',

  'chat.planCount': '{done} of {total}',

  // A message typed while the assistant is still working, waiting above the
  // composer until the current step finishes.
  'queue.more': 'Show more',
  'queue.less': 'Show less',
  'queue.now': 'Send now',
  'queue.nowHint': 'Send this immediately, without waiting for the current step to finish',
  'queue.remove': 'Delete this waiting message',
  'empty.title': 'What should we work on?',
  'empty.body':
    'Pick a model, ask for anything. With your computer connected, the assistant can read files, edit code and run commands there.',

  /* ── the model ─────────────────────────────────────────────────── */
  'model.free.tooltip':
    '{model} — a free model. Fine for everyday questions; rate-limited and weaker at long multi-step jobs. Press to change.',
  'model.switched': 'Now using {model}.',

  /* ── onboarding ────────────────────────────────────────────────── */
  'onb.title': 'Getting started with AI Remote',
  'onb.step': 'Step {n} of {total}',
  'onb.reopen': 'Show the getting-started guide again',

  'onb.1.title': 'What AI Remote does for you',
  'onb.1.body': 'This is not a chatbot that only answers. It does real work on your computer.',
  'onb.1.a': 'Reads and edits files, runs commands, drives a browser — on your machine, while you watch.',
  'onb.1.b': 'Writes real quotations, reports, spreadsheets and decks you can download from the chat.',
  'onb.1.c': 'Driven from your phone, a tablet, or another laptop.',
  'onb.1.note': 'You can always see what it is doing, and the dangerous things stop and ask you first.',

  'onb.2.title': 'Paste in an API key',
  'onb.2.body':
    'An API key is the password that lets the assistant call an AI model. You get it from the provider yourself and paste it here once.',
  'onb.2.recommend':
    'If you are new: use OpenRouter. One key reaches almost every model, and a number of them are free.',
  'onb.2.open': 'Open the key settings',
  'onb.2.done': 'Done — this account has a key.',
  'onb.2.pending': 'No key yet. Until one is pasted, the assistant cannot answer.',
  'onb.2.safety': 'Keys are encrypted on your own server and never sent back to the browser.',

  'onb.3.title': 'The model you are on',
  'onb.3.free': 'You are on a FREE model. Good enough for questions, writing, and everyday work.',
  'onb.3.freeWarn':
    'Worth being straight about: free models are rate-limited and weaker at long multi-step jobs. If a long task stalls halfway, switching to a paid model is the fix.',
  'onb.3.paid': 'You are on a paid model — billed to your own key.',
  'onb.3.change': 'Change model',
  'onb.3.note': 'There is one model for the whole app, so changing it anywhere changes it everywhere.',

  'onb.4.title': 'Try your first question',
  'onb.4.body': 'Press one below and it runs. You watch it work, step by step.',
  'onb.4.try1': 'My computer feels slow — find out why',
  'onb.4.try2': 'Find me five technology stories worth reading this week',
  'onb.4.try3': 'Make me a spreadsheet for tracking monthly expenses',
  'onb.4.note': 'Write the way you would talk. There are no special commands to learn.',

  'onb.5.title': 'How much the assistant may do on its own',
  'onb.5.body': 'The button beside Send decides what it just does and what it stops to ask about.',
  'onb.5.guarded':
    'Guarded (recommended) — everyday work runs straight away; deleting things or writing outside your working folder stops and asks.',
  'onb.5.auto': 'Auto-run — fastest, and the one that can lose work.',
  'onb.5.ask': 'Ask first — safest, and you will be asked a lot.',
  'onb.5.honest':
    'Plainly: the "is this dangerous" check is a list of known patterns, not a sealed cage. Something destructive it does not recognise will still run. If you need certainty, choose "Ask first".',
  'onb.5.finish': 'Done. Start working.',

  /* ── settings ──────────────────────────────────────────────────── */
  'settings.title': 'Settings',
  'settings.tab.providers': 'Providers',
  'settings.tab.models': 'Models',
  'settings.tab.behaviour': 'Behaviour',
  'settings.tab.skills': 'Skills',
  'settings.tab.tasks': 'Scheduled',
  'settings.tab.connectors': 'Connectors',
  'settings.tab.worker': 'Computers',
  'settings.tab.account': 'Account',
  'settings.tab.people': 'People',
  'settings.language.label': 'Language',
  'settings.language.hint': 'Applies immediately, and follows your account onto every device.',
  'settings.help.label': 'Guide',
  'settings.help.hint': 'Show the five-step guide for people just starting out.',
/* ── MCP ───────────────────────────────────────────────────────── */
  'settings.tab.mcp': 'MCP servers',
  'mcp.lede':
    'MCP servers add tools from outside this app — Figma, Jira, Sentry, a database, hundreds of others. Plug one in and the assistant can use it. Nothing here is chosen by the assistant: you type the command, and every tool from a server stops and asks before it runs.',
  'mcp.name': 'Name',
  'mcp.transport': 'How to reach it',
  'mcp.transport.stdio': 'A program on this computer',
  'mcp.transport.http': 'A URL',
  'mcp.command': 'Command',
  'mcp.command.hint':
    'The whole command line, exactly as you would type it in a terminal. This runs a program on your computer, so only paste something you trust.',
  'mcp.url': 'Server URL',
  'mcp.headers': 'Headers',
  'mcp.headers.hint': 'One per line, as Name: value. Encrypted on the server and never sent back to the browser.',
  'mcp.add': 'Connect',
  'mcp.connected': 'Connected',
  'mcp.none': 'None yet. The assistant still has every tool this app comes with.',
  'mcp.trying': 'Trying to start it… the first run may take a moment to download.',
  'mcp.added': 'Done — {n} tools found. The assistant can use them from the next message.',
  'mcp.needName': 'Give the server a name first.',
  'mcp.needCommand': 'Give the command that starts the server.',
  'mcp.tools': '{n} tools',
  'mcp.broken': 'not starting',
  'mcp.off': 'off',
  'mcp.enable': 'Enable',
  'mcp.disable': 'Disable',
  'mcp.remove': 'Remove',
  'mcp.suggested': 'Suggested servers',
  'mcp.suggested.hint': 'Press one to fill the form in. Nothing is installed or run until you press Connect.',
  'mcp.needs': 'needs a token',
  'mcp.presetReady': '{name} is filled in. Press Connect to try it.',
  'gate.name': 'Your name',
  'gate.email': 'Email address',
  'gate.password': 'Password',
  'gate.totp': 'Authenticator code',
  'gate.resetcode': 'The 6-digit code from your email',
  'gate.newpassword': 'New password',
  'pages.searchInput': 'Search projects',
  'project.askInput': 'Ask about this project',
  'composer.attachInput': 'Attach files',
  'pair.codeInput': 'Pairing code from your computer',
  'models.searchInput': 'Search models',
  'models.sortInput': 'Sort order',
  'workspace.findInput': 'Search in these files',
  'search.inputLabel': 'Search titles and everything said',
  'task.whenInput': 'When to run it',
  'gate.hidePassword': 'Hide password',
  'gate.showPassword': 'Show password',
  'gate.sub.reset': 'Enter the code from your email and choose a new password.',
  'gate.sub.forgot': 'Enter your email and we will send you a reset code.',
  'gate.sub.first': 'Create the first account — it becomes the administrator.',
  'gate.sub.signup': 'Create your account.',
  'gate.sub.signin': 'Sign in to continue.',
  'gate.submit.reset': 'Set new password',
  'gate.submit.forgot': 'Send reset link',
  'gate.submit.signup': 'Create account',
  'gate.switch.toSignin': 'Already have an account? Sign in',
  'gate.switch.toSignup': 'Need an account? Sign up',
  'gate.note.firstAccount': 'Nobody has registered on this deployment yet. Create the first account instead.',
  'gate.note.resetSent': 'If that address has an account, a reset code is on its way. Enter it below.',
  'gate.note.passwordUpdated': 'Password updated. Sign in with your new password.',
  'gate.note.noMail': 'No mail provider configured — the confirmation code is in the server log.',
  'gate.error.generic': 'That did not work.',
  'suggest.workspace': 'Show me what is in my workspace and summarise the project.',
  'suggest.library': 'Search the web for what changed in this library recently.',
  'suggest.todos': 'Find every TODO in the codebase and group them by file.',
  'suggest.tests': 'Run the test suite and explain any failures.',
  'chat.openFailed': 'That conversation could not be opened.',
  'nav.noConversations': 'No conversations yet',
  'chat.deleted': 'Conversation deleted.',
  'chat.answersFrom': 'Answers from',
  'chat.answersFirstFrom': 'Answers first from',
  'project.namePrompt': 'Give it a name — a subject, a client, a piece of coursework.',
  'clipboard.failed': 'Could not reach the clipboard — select the text and press Ctrl+C.',
  'chat.stopBeforeEdit': 'Stop the run first — editing rewinds the conversation.',
  'chat.stillSaving': 'This message is still being saved. Try again in a moment.',
  'composer.empty': 'A message cannot be empty.',
  'composer.uploading': 'Still uploading — one moment.',
  'worker.fullDisk': 'File tools: the whole disk',
  'worker.desktopOff': 'Desktop control: off',
  'worker.noTools': 'File and shell tools are hidden from the assistant until a worker connects.',
  'settings.effort': 'Reasoning effort',
  'action.reallyRemove': 'Really remove?',
  'account.nameUpdated': 'Name updated.',
  'account.totpOff': 'Two-factor authentication turned off.',
  'account.passwordUpdatedAll': 'Password updated. Every other device has been signed out.',
  'account.passwordUpdated': 'Password updated.',
  'admin.tokenLimit': 'Monthly token limit while using the shared API key. 0 means no limit.',
  'models.verifying': 'Verifying with OpenRouter…',
  'devices.calling': 'Calling each one…',
  'devices.add': 'Add a computer',
  'devices.thisOne': 'This computer',
  'devices.yours': 'Your computers — add another, or switch which one is in use',
  'devices.none': 'No computer connected. Click to add one.',
  'devices.waiting': 'Waiting to be added.',
  'devices.willReport': 'It will report where it is working once it connects.',
  'devices.moved': 'Saved. That computer will move within about fifteen seconds.',
  'devices.switched': 'Switched computer.',
  'devices.reallyUnpair': 'Really unpair?',
  'news.contextWindow': 'Context window',
  'news.yourKey': 'Your OpenRouter key',
  'news.free': 'This one is free — it costs nothing to try.',
  'news.billed': 'Billed to your own OpenRouter key at the rate above.',
  'compact.turnOn': 'Turn on auto-compacting',
  'compact.turnOff': 'Turn off auto-compacting',
  'compact.onHint': 'Fold the older turns up automatically before the window fills.',
  'compact.offHint': 'The conversation will stop working once the window is full.',
  'compact.isOn': 'Auto-compacting is on.',
  'compact.isOff': 'Auto-compacting is off. Long conversations will hit the window.',
  'compact.now': 'Compact now',
  'compact.nowHint': 'Summarise the earlier turns and carry on with the room that frees up.',
  'compact.nothing': 'Nothing to compact yet.',
  'compact.working': 'Folding the earlier turns up…',
  'action.expandMenu': 'Expand menu',
  'file.docx': 'Word document',
  'file.xlsx': 'Excel workbook',
  'file.pptx': 'PowerPoint deck',
  'file.csv': 'Spreadsheet data',
  'file.html': 'Web page',
  'file.txt': 'Plain text',
  'session.expired': 'Session expired.',
  'account.yourPassword': 'Your password',
  'account.enterCode': 'Enter the 6-digit code',
  'devices.revertedToOwn': 'Saved. It will go back to the machine\'s own setting.',
  'pages.tasks.lede': 'Work that runs on a clock, or whenever you press it. Each run lands in its own conversation, ready to read later.',
};
