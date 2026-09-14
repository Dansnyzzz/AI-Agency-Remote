/**
 * Check a tool call's arguments against the tool's own schema before it runs.
 *
 * This is what OpenAI's `strict: true` would give, done on the server so it holds
 * on every provider. Anthropic enforces its schema before a call is emitted; the
 * OpenAI-compatible adapter and Gemini do not, and turning strict on there is not
 * a one-line change — measured, 0 of the 93 tool schemas meet OpenAI's strict
 * subset, and behaviour through OpenRouter and OrcaRouter depends on the upstream
 * model (GAP-004). What strict mode is *for* is simpler and checkable here: a
 * tool should not run with a required argument missing, or with a value the
 * schema says cannot be there.
 *
 * The missing-argument case is the one with teeth in this codebase. A tool that
 * destructures an absent `path` gets `undefined`, and tool defaults turn that
 * into something wide — `resolveInWorkspace(undefined)` is the workspace root.
 * AUTO-005 closed the version of this where the arguments failed to parse; a
 * model that simply omits a required field produced the same widening and
 * nothing stopped it.
 *
 * Deliberately not a general JSON Schema implementation. The catalogue uses
 * exactly six keywords — `type`, `description`, `properties`, `required`,
 * `enum`, `items` — and no combinators, so this covers those six completely
 * rather than a larger set approximately. A tool that starts using another
 * keyword is covered by the test that asserts the catalogue still only uses
 * these, so the gap cannot open silently.
 *
 * Strict where the harm is, lenient where models are merely sloppy:
 *
 *   - a missing required field is refused;
 *   - a value outside an `enum` is refused, with the allowed values named;
 *   - an object or array of the wrong kind is refused;
 *   - `"5"` for a number and `"true"` for a boolean are **coerced**, because
 *     models send them constantly and refusing would turn a working call into
 *     a retry that costs a full step;
 *   - a number or boolean where a string is wanted becomes that string.
 *
 * Returns `{ ok: true, input }` with the coerced input, or `{ ok: false, error }`
 * with a sentence written for the model to act on.
 */

export const SUPPORTED_KEYWORDS = new Set(['type', 'description', 'properties', 'required', 'enum', 'items']);

const kindOf = (value) => (Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);

function coerce(value, type) {
  if (type === 'integer' || type === 'number') {
    if (typeof value === 'number') {
      return type === 'integer' && !Number.isInteger(value) ? { ok: false } : { ok: true, value };
    }
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      const n = Number(value);
      return type === 'integer' && !Number.isInteger(n) ? { ok: false } : { ok: true, value: n };
    }
    return { ok: false };
  }
  if (type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
    return { ok: false };
  }
  if (type === 'string') {
    if (typeof value === 'string') return { ok: true, value };
    if (typeof value === 'number' || typeof value === 'boolean') return { ok: true, value: String(value) };
    return { ok: false };
  }
  if (type === 'array') return Array.isArray(value) ? { ok: true, value } : { ok: false };
  if (type === 'object') {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value } : { ok: false };
  }
  // A type this validator does not know about is not a reason to refuse a call.
  return { ok: true, value };
}

function check(value, schema, where) {
  if (!schema || typeof schema !== 'object') return { ok: true, value };

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    let coerced = null;
    for (const type of types) {
      const attempt = coerce(value, type);
      if (attempt.ok) {
        coerced = attempt;
        break;
      }
    }
    if (!coerced) {
      return { ok: false, error: `${where} should be ${types.join(' or ')}, but got ${kindOf(value)}.` };
    }
    value = coerced.value;
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return {
      ok: false,
      error: `${where} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(', ')}, but got ${JSON.stringify(value)}.`,
    };
  }

  if (Array.isArray(value) && schema.items) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      const item = check(value[i], schema.items, `${where}[${i}]`);
      if (!item.ok) return item;
      out.push(item.value);
    }
    value = out;
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) {
      if (value[key] === undefined || value[key] === null) {
        return { ok: false, error: `${where === 'arguments' ? '' : `${where}.`}${key} is required and was not given.` };
      }
    }
    if (schema.properties) {
      const out = { ...value };
      for (const [key, sub] of Object.entries(schema.properties)) {
        // Absent optional fields stay absent, so the tool's own default applies —
        // and a `null` is removed rather than passed on, because destructuring
        // defaults fire for `undefined` only. `{ cwd = '.' }` given `null` keeps
        // `null`, which is not what either the model or the tool meant.
        if (value[key] === undefined) continue;
        if (value[key] === null) {
          delete out[key];
          continue;
        }
        const field = check(value[key], sub, where === 'arguments' ? key : `${where}.${key}`);
        if (!field.ok) return field;
        out[key] = field.value;
      }
      value = out;
    }
  }

  return { ok: true, value };
}

/**
 * @param {object} schema  a tool's `parameters`
 * @param {unknown} input  the arguments the model sent
 */
export function validateArguments(schema, input) {
  const result = check(input ?? {}, schema, 'arguments');
  return result.ok ? { ok: true, input: result.value } : { ok: false, error: result.error };
}
