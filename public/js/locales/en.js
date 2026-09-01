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
  'composer.attach': 'Attach photos or files',
  'composer.send': 'Send',
  'composer.stop': 'Stop',
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
};
