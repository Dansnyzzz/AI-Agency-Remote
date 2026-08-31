/**
 * What the tool catalogue costs, measured against the window it has to fit in.
 *
 * The catalogue is re-sent on every step of every turn, so its size is a tax on
 * the whole conversation. The rule used to be an absolute one — trim below a
 * 40k window — which got both ends wrong: a 65k model with a paired computer
 * carried the full 12k catalogue (nearly a fifth of its window) untrimmed, while
 * a 30k model with no computer had its descriptions cut for a catalogue that was
 * only 5k. What matters is the share, not the size, and that is what is pinned
 * here.
 *
 *   node test/toolbudget.test.mjs
 */
process.env.ENCRYPTION_KEY ||= 'budget-test-key';
process.env.SESSION_SECRET ||= 'budget-test-secret';

let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { availableTools, __testing } = await import('../server/tools/definitions.js');
const { estimateTokens } = __testing;

const all = (context, workerOnline = true) =>
  availableTools({ workerOnline, desktopOnline: workerOnline, policy: 'auto', context });
const full = (t) => t.description.length;

section('a catalogue that fits comfortably is left alone');
{
  // A big window: the guidance in the long descriptions is what stops a model
  // reaching for the wrong tool, and there is room for it.
  const roomy = all(1_000_000);
  const untrimmed = all(0); // no context stated at all
  check('nothing is trimmed on a large window', roomy.map(full).join() === untrimmed.map(full).join());
  check('and the share is small', estimateTokens(roomy) < 1_000_000 * 0.12, `${estimateTokens(roomy)} tok`);
}

section('a catalogue that would crowd the window is cut down');
{
  const big = estimateTokens(all(1_000_000));
  // A window where the full catalogue is over its share, but the trimmed one is
  // comfortably under — so descriptions are shortened and nothing is dropped.
  const window = big * 5;
  const cut = all(window);
  check('descriptions are shortened', estimateTokens(cut) < big, `${estimateTokens(cut)} < ${big}`);
  check('but every tool is still offered', cut.length === all(1_000_000).length, `${cut.length}`);
  check('and it now fits the allowance', estimateTokens(cut) <= window * 0.2, `${estimateTokens(cut)} of ${window}`);
}

section('a window too small even for that drops the optional tools');
{
  const big = estimateTokens(all(1_000_000));
  const tiny = Math.round(big / 2); // catalogue is twice the window
  const cut = all(tiny);
  const secondary = all(1_000_000).filter((t) => t.secondary).map((t) => t.name);
  check('there are optional tools to drop', secondary.length > 0, secondary.join(','));
  check('and none of them survive', cut.every((t) => !secondary.includes(t.name)), cut.length + ' left');
  check('while the essential ones do', cut.some((t) => t.name === 'web_search'));
}

section('the decision is by share, not by absolute window size');
{
  // The bug this replaces: the same catalogue was trimmed or not depending only
  // on the window, so a small catalogue in a mid-size window was cut for nothing.
  const small = availableTools({ workerOnline: false, desktopOnline: false, policy: 'auto', context: 65_000 });
  const smallUntrimmed = availableTools({ workerOnline: false, desktopOnline: false, policy: 'auto', context: 0 });
  check(
    'a small catalogue in a 65k window keeps its guidance',
    small.map(full).join() === smallUntrimmed.map(full).join(),
    `${estimateTokens(small)} tok of 65k`,
  );

  // The same window, but with a paired computer the catalogue is far larger —
  // now it does need cutting.
  const large = availableTools({ workerOnline: true, desktopOnline: true, policy: 'auto', context: 65_000 });
  const largeUntrimmed = availableTools({ workerOnline: true, desktopOnline: true, policy: 'auto', context: 0 });
  check(
    'the same window with a full catalogue does get cut',
    estimateTokens(large) < estimateTokens(largeUntrimmed),
    `${estimateTokens(large)} < ${estimateTokens(largeUntrimmed)}`,
  );
}

console.log(
  failures === 0 ? '\n\x1b[32mAll tool-budget checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
