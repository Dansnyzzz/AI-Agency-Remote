import OpenAI from 'openai';

/**
 * Shared adapter for every OpenAI-Chat-Completions-shaped API: OpenAI itself
 * and OpenRouter, which deliberately mirrors the same wire format.
 */

/**
 * Attachments, in the OpenAI chat shape.
 *
 * Images become `image_url` parts with a data: URI, which OpenAI and OpenRouter
 * both take. PDFs do not exist in this wire format at all, so by the time a
 * document reaches here it has already been turned into text upstream — the
 * attachment layer knows which providers can be handed a file and which cannot.
 *
 * A `document` part arriving here anyway means something bypassed that, and it
 * is still not allowed to vanish quietly: a file that uploads, appears, and is
 * silently not looked at is the worst outcome available.
 */
function attachmentParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.type === 'text') out.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      out.push({ type: 'image_url', image_url: { url: `data:${part.mime};base64,${part.data}` } });
    } else if (part.type === 'document') {
      out.push({
        type: 'text',
        text:
          `[The user attached "${part.name}" (PDF) and it could not be read for this model. Say ` +
          'so plainly and suggest a Claude or Gemini model, which can read the pages themselves.]',
      });
    }
  }
  return out;
}

function toMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });

  for (const m of messages) {
    if (m.role === 'user') {
      const files = attachmentParts(m.parts || []);
      if (files.length) {
        // The multi-part form is only used when there is something to put in it:
        // a plain string is what every model handles best, including the many
        // that reject the array form outright.
        const content = [...files];
        if (m.text) content.push({ type: 'text', text: m.text });
        out.push({ role: 'user', content });
      } else {
        out.push({ role: 'user', content: m.text || '' });
      }
    } else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.text || null };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }));
      }
      // A turn with neither text nor tool calls is rejected as empty.
      if (msg.content || msg.tool_calls) out.push(msg);
    } else if (m.role === 'tool') {
      // One `tool` message per result, unlike Anthropic's single grouped turn.
      for (const r of m.results || []) {
        out.push({ role: 'tool', tool_call_id: r.toolCallId, content: String(r.content ?? '') });
      }
    }
  }
  return out;
}

const REASONING = /^(o\d|gpt-5|.*\bthinking\b)/i;

export async function* streamOpenAICompatible({
  apiKey,
  baseURL,
  headers,
  model,
  entry,
  system,
  messages,
  tools,
  effort = 'high',
  maxTokens = 32000,
  signal,
}) {
  // maxRetries: 0 hands all retrying to streamCompletion, which is the layer
  // that knows about the account's other keys. The SDK's own default of 2 would
  // sit through two backoffs on a key already rate limited before this function
  // even returns — so a spare key waits behind the dead one, and a 429 that
  // should have marked a key resting is silently retried away instead.
  const client = new OpenAI({ apiKey, baseURL, defaultHeaders: headers, maxRetries: 0 });

  const params = {
    model,
    messages: toMessages(messages, system),
    stream: true,
    stream_options: { include_usage: true },
    // `max_completion_tokens` is OpenAI's newer spelling; OpenRouter, Ollama,
    // LM Studio and friends still expect `max_tokens`.
    ...(baseURL ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }),
  };
  if (tools?.length) {
    params.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  // `reasoning_effort` is rejected outright by non-reasoning models, so only
  // send it where the model id says it will be understood.
  if (REASONING.test(model) || entry?.tags?.includes('reasoning')) {
    params.reasoning_effort = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
  }

  const stream = await client.chat.completions.create(params, { signal });

  /** index -> { id, name, args } — tool call arguments arrive as JSON fragments. */
  const pending = new Map();
  let usage = null;
  let stopReason = null;

  for await (const chunk of stream) {
    if (chunk.usage) {
      usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) stopReason = choice.finish_reason;

    const delta = choice.delta || {};
    if (delta.content) yield { type: 'text', delta: delta.content };
    // OpenRouter surfaces reasoning traces on a non-standard field.
    if (delta.reasoning) yield { type: 'thinking', delta: delta.reasoning };

    for (const tc of delta.tool_calls || []) {
      const slot = pending.get(tc.index) || { id: '', name: '', args: '' };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) {
        slot.name = tc.function.name;
        yield { type: 'tool_call_start', id: slot.id, name: slot.name };
      }
      if (tc.function?.arguments) slot.args += tc.function.arguments;
      pending.set(tc.index, slot);
    }
  }

  const toolCalls = [...pending.values()].map((slot) => {
    let input = {};
    try {
      input = slot.args ? JSON.parse(slot.args) : {};
    } catch {
      input = { __unparsed: slot.args };
    }
    return { id: slot.id || `call_${slot.name}`, name: slot.name, input };
  });

  yield { type: 'done', stopReason, toolCalls, usage: usage || { input: 0, output: 0 } };
}

/** Exposed so the suite can assert what the OpenAI wire format is handed. */
export const __testing = { toMessages };
