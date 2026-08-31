/**
 * A calculator the assistant can actually rely on.
 *
 * Getting sums wrong is the oldest failure a language model has, and the one
 * that costs most in a report: a total that does not add up puts every number
 * beside it in doubt. So arithmetic is done here, by evaluating the expression,
 * rather than recalled.
 *
 * **This is a parser, not a code runner, and that is a security decision.** The
 * obvious implementation is `node:vm`, and it would be wrong: `vm` is an
 * isolation boundary for trusted code, not a security sandbox — the constructor
 * chain escapes it, and on the other side sits `process.env`, which on this
 * deployment holds the key every account's stored credentials are encrypted
 * under. The model reads web pages, and a web page can tell it what to compute
 * next, so the input here is not trustworthy. A recursive-descent parser over
 * numbers, operators and a fixed function table has nothing to escape from: the
 * worst a hostile expression can do is fail to parse.
 */

const FUNCTIONS = {
  sum: (xs) => xs.reduce((a, b) => a + b, 0),
  avg: (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0),
  mean: (xs) => FUNCTIONS.avg(xs),
  median: (xs) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  },
  min: (xs) => Math.min(...xs),
  max: (xs) => Math.max(...xs),
  count: (xs) => xs.length,
  abs: (xs) => Math.abs(xs[0]),
  sqrt: (xs) => Math.sqrt(xs[0]),
  round: (xs) => {
    const places = xs.length > 1 ? Math.max(0, Math.min(10, Math.trunc(xs[1]))) : 0;
    const factor = 10 ** places;
    return Math.round(xs[0] * factor) / factor;
  },
  stdev: (xs) => {
    if (xs.length < 2) return 0;
    const m = FUNCTIONS.avg(xs);
    return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
  },
};

/** Numbers, operators, brackets, commas and bare function names. Nothing else. */
function tokenise(src) {
  const tokens = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(ch)) {
      const match = /^\d*\.?\d+(?:[eE][+-]?\d+)?/.exec(src.slice(i));
      if (!match) throw new Error(`"${src.slice(i, i + 8)}" is not a number this can read.`);
      tokens.push({ type: 'number', value: Number(match[0]) });
      i += match[0].length;
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const match = /^[a-zA-Z_][a-zA-Z0-9_]*/.exec(src.slice(i));
      tokens.push({ type: 'name', value: match[0] });
      i += match[0].length;
      continue;
    }
    if ('+-*/^(),[]'.includes(ch)) {
      tokens.push({ type: ch });
      i += 1;
      continue;
    }
    // Everything else — a dot after a name, a quote, a semicolon, a brace — is
    // the shape of code rather than of arithmetic, and is refused by name.
    throw new Error(`"${ch}" has no meaning in a calculation. Use numbers, + - * / ^ ( ), lists and the named functions.`);
  }
  return tokens;
}

/**
 * expression := term (('+' | '-') term)*
 * term       := power (('*' | '/') power)*
 * power      := unary ('^' power)?      — right-associative
 * unary      := '-' unary | primary
 * primary    := number | name '(' args ')' | '(' expression ')' | list
 */
function parser(tokens, source) {
  let pos = 0;
  const peek = () => tokens[pos];
  const take = (type) => {
    if (!tokens[pos] || tokens[pos].type !== type) {
      throw new Error(`Expected ${type} in "${source}" — the expression is incomplete or mis-bracketed.`);
    }
    return tokens[pos++];
  };

  function list() {
    take('[');
    const items = [];
    if (peek()?.type !== ']') {
      items.push(expression());
      while (peek()?.type === ',') {
        pos += 1;
        items.push(expression());
      }
    }
    take(']');
    return items;
  }

  function primary() {
    const t = peek();
    if (!t) throw new Error(`"${source}" ends before it is finished.`);

    if (t.type === 'number') {
      pos += 1;
      return t.value;
    }
    if (t.type === '(') {
      pos += 1;
      const value = expression();
      take(')');
      return value;
    }
    if (t.type === '[') {
      // A bare list has no value of its own; it only makes sense inside a call.
      throw new Error('A list on its own is not a number. Use it inside a function, like sum([1, 2, 3]).');
    }
    if (t.type === 'name') {
      pos += 1;
      const fn = FUNCTIONS[t.value];
      if (!fn) {
        throw new Error(
          `"${t.value}" is not a function this knows. Available: ${Object.keys(FUNCTIONS).join(', ')}.`,
        );
      }
      take('(');
      /** Arguments flatten, so sum([1,2]) and sum(1,2) both work. */
      const args = [];
      if (peek()?.type !== ')') {
        const push = () => {
          if (peek()?.type === '[') args.push(...list());
          else args.push(expression());
        };
        push();
        while (peek()?.type === ',') {
          pos += 1;
          push();
        }
      }
      take(')');
      return fn(args);
    }
    throw new Error(`"${source}" has something where a number should be.`);
  }

  function unary() {
    if (peek()?.type === '-') {
      pos += 1;
      return -unary();
    }
    if (peek()?.type === '+') {
      pos += 1;
      return unary();
    }
    return primary();
  }

  function power() {
    const base = unary();
    if (peek()?.type === '^') {
      pos += 1;
      return base ** power();
    }
    return base;
  }

  function term() {
    let value = power();
    while (peek()?.type === '*' || peek()?.type === '/') {
      const op = tokens[pos++].type;
      const right = power();
      if (op === '/' && right === 0) {
        throw new Error('That divides by zero, which has no answer. Check the denominator.');
      }
      value = op === '*' ? value * right : value / right;
    }
    return value;
  }

  function expression() {
    let value = term();
    while (peek()?.type === '+' || peek()?.type === '-') {
      const op = tokens[pos++].type;
      value = op === '+' ? value + term() : value - term();
    }
    return value;
  }

  const result = expression();
  if (pos < tokens.length) {
    throw new Error(`"${source}" has something left over after the expression — check the brackets and operators.`);
  }
  return result;
}

/**
 * @returns { value, expression } — the answer, and the expression it came from,
 *   so a reader can check the working rather than taking the number on trust.
 */
export function evaluate(source) {
  const src = String(source ?? '').trim();
  if (!src) throw new Error('There is nothing to calculate.');
  if (src.length > 2000) throw new Error('That expression is too long to be arithmetic.');

  const value = parser(tokenise(src), src);
  if (!Number.isFinite(value)) {
    throw new Error('That does not come out to a finite number. Check for a division by zero or an overflow.');
  }
  return { value, expression: src };
}

/** Exposed so the tool description can list what is available without drifting. */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS);
