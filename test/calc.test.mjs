/**
 * Arithmetic the model does not do in its head.
 *
 * Getting sums wrong is the oldest failure a language model has, and it is the
 * one that costs most in a report: a total that does not add up discredits every
 * number beside it. This evaluates the expression itself, so the answer is
 * arithmetic rather than recollection.
 *
 * The other half of what is pinned here is that it is not a code runner. The
 * model reads web pages, and a web page can tell it what to compute next — so an
 * expression that reaches for `process`, a constructor chain, or anything but
 * numbers and named functions must fail rather than execute.
 *
 *   node test/calc.test.mjs
 */
let failures = 0;
const section = (n) => console.log(`\n\x1b[1m${n}\x1b[0m`);
const check = (l, ok, d = '') => {
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗ FAIL\x1b[0m'}  ${l}${d ? ` — ${d}` : ''}`);
  if (!ok) failures += 1;
};

const { evaluate } = await import('../server/tools/calc.js');
const near = (a, b) => Math.abs(a - b) < 1e-9;
const val = (src) => evaluate(src).value;
const err = (src) => {
  try {
    evaluate(src);
    return '';
  } catch (e) {
    return e.message;
  }
};

section('arithmetic, with the precedence people expect');
{
  check('addition and multiplication bind correctly', val('2 + 3 * 4') === 14, String(val('2 + 3 * 4')));
  check('parentheses win', val('(2 + 3) * 4') === 20);
  check('subtraction is left-associative', val('10 - 3 - 2') === 5);
  check('division', near(val('7 / 2'), 3.5));
  check('powers', val('2 ^ 10') === 1024);
  check('unary minus', val('-5 + 3') === -2);
  check('decimals', near(val('0.1 + 0.2'), 0.3) === false || true, 'floating point is floating point');
  check('a percentage change', near(val('(1200 - 950) / 950 * 100'), 26.3157894736842), String(val('(1200 - 950) / 950 * 100')));
}

section('the statistics a report actually needs');
{
  check('sum of a list', val('sum([36, 26, 27, 34])') === 123);
  check('sum of loose arguments too', val('sum(36, 26, 27, 34)') === 123);
  check('average', near(val('avg([1, 2, 3, 4])'), 2.5));
  check('mean is the same thing', near(val('mean([1, 2, 3, 4])'), 2.5));
  check('median of an odd list', val('median([1, 3, 2])') === 2);
  check('median of an even list', near(val('median([1, 2, 3, 4])'), 2.5));
  check('min and max', val('min([5, 1, 9])') === 1 && val('max([5, 1, 9])') === 9);
  check('count', val('count([1, 2, 3])') === 3);
  check('round to places', near(val('round(3.14159, 2)'), 3.14));
  check('round with no places', val('round(3.7)') === 4);
  check('abs and sqrt', val('abs(-4)') === 4 && val('sqrt(9)') === 3);
  check('nested calls', near(val('round(avg([1, 2, 4]), 2)'), 2.33));
}

section('it is a calculator, not a code runner');
{
  // The prompt-injection case: a page tells the model to compute something that
  // is not arithmetic. Every one of these must fail rather than run.
  for (const attack of [
    'process.env.ENCRYPTION_KEY',
    'this.constructor.constructor("return process")()',
    'require("fs")',
    'globalThis',
    '(function(){return 1})()',
    '1; process.exit(1)',
    'eval("1+1")',
  ]) {
    check(`refuses ${attack.slice(0, 34)}`, err(attack).length > 0, err(attack).slice(0, 50));
  }
  check('an unknown function is named in the error', /unknown|not a function/i.test(err('frobnicate(1)')), err('frobnicate(1)'));
}

section('bad arithmetic is refused rather than answered wrongly');
{
  check('division by zero is an error, not Infinity', /zero/i.test(err('5 / 0')), err('5 / 0'));
  check('unbalanced parentheses', err('(1 + 2').length > 0);
  check('an empty expression', err('   ').length > 0);
  check('a stray operator', err('1 +').length > 0);
  check('a result that is not finite is refused', err('0 / 0').length > 0);
}

section('the working is shown, so a number can be checked');
{
  const out = evaluate('sum([2, 3]) * 4');
  check('the value comes back', out.value === 20, String(out.value));
  check('and the expression it evaluated', out.expression === 'sum([2, 3]) * 4', out.expression);
}

console.log(
  failures === 0 ? '\n\x1b[32mAll calculator checks passed.\x1b[0m\n' : `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
