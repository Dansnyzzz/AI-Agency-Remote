import Anthropic from '@anthropic-ai/sdk';

/**
 * Anthropic adapter.
 *
 * Assistant turns keep their original content blocks in `msg.raw.anthropic` and
 * are replayed verbatim. Thinking blocks carry a signature the API validates, so
 * rebuilding them from plain text would either lose the reasoning or 400.
 */

/**
 * Attachments, in Anthropic's shape.
 *
 * Images and PDFs both go native here — Claude reads a PDF as a document rather
 * than needing it flattened to text first, which is the whole reason to send it
 * as one.
 */
function attachmentBlocks(parts) {
  const blocks = [];
  for (const part of parts) {
    if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image') {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: part.mime, data: part.data },
      });
    } else if (part.type === 'document') {
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: part.data },
        title: part.name,
      });
    }
  }
  return blocks;
}

/**
 * Mark where the reusable part of the conversation ends.
 *
 * `system` already carries a breakpoint, so the tools and the system prompt are
 * cached — but the transcript was not, and the transcript is the part that grows.
 * A conversation twenty turns in re-sent every one of those turns at full price
 * on every step of every turn, which on an agentic loop is the largest single
 * cost in the app.
 *
 * The breakpoint goes on the **second-to-last** message rather than the last one.
 * That is the whole trick: the last message is what is new this turn, so a cache
 * written through it could never be read. Written one message back, the cache
 * this turn writes is the prefix the next turn reads.
 *
 * Nothing is mutated in place. Assistant turns are replayed from
 * `m.raw.anthropic`, which is the array held in the database — writing a
 * `cache_control` into it would persist a wire detail into stored history and
 * then send it again next turn in the wrong place.
 *
 * Below Anthropic's minimum cacheable prefix the breakpoint is simply ignored,
 * so there is nothing to guard against on a short conversation.
 */
function withCachePoint(out) {
  if (out.length < 2) return out;

  const at = out.length - 2;
  const blocks = out[at]?.content;
  if (!Array.isArray(blocks) || !blocks.length) return out;

  const copy = [...out];
  const last = blocks[blocks.length - 1];
  copy[at] = {
    ...out[at],
    content: [...blocks.slice(0, -1), { ...last, cache_control: { type: 'ephemeral' } }],
  };
  return copy;
}

function toMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      // Files first, then the words about them: the question reads better after
      // the thing it is about, and it is the order a person would hand them over.
      const content = [...attachmentBlocks(m.parts || []), { type: 'text', text: m.text || '' }];
      out.push({ role: 'user', content: content.filter((b) => b.type !== 'text' || b.text) });
    } else if (m.role === 'assistant') {
      if (m.raw?.anthropic?.length) {
        out.push({ role: 'assistant', content: m.raw.anthropic });
      } else {
        const content = [];
        if (m.text) content.push({ type: 'text', text: m.text });
        for (const call of m.toolCalls || []) {
          content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} });
        }
        if (content.length) out.push({ role: 'assistant', content });
      }
    } else if (m.role === 'tool') {
      // Every tool_result for one assistant turn must arrive in a single user
      // message, or Claude learns to stop making parallel tool calls.
      out.push({
        role: 'user',
        content: (m.results || []).map((r) => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: String(r.content ?? ''),
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
    }
  }
  return out;
}

export async function* streamAnthropic({
  apiKey,
  baseURL,
  model,
  entry,
  system,
  messages,
  tools,
  effort = 'high',
  maxTokens = 32000,
  signal,
}) {
  // maxRetries: 0 for the same reason as the OpenAI adapter — streamCompletion
  // owns retrying, because it is the layer that can move to another key rather
  // than backing off on this one. The SDK default of 2 would double the wait on
  // a limited key and hide the 429 that should have rested it.
  const client = new Anthropic({ apiKey, maxRetries: 0, ...(baseURL ? { baseURL } : {}) });

  const params = {
    model,
    max_tokens: maxTokens,
    messages: withCachePoint(toMessages(messages)),
    ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
    ...(tools?.length
      ? {
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: t.parameters,
          })),
        }
      : {}),
  };
  // Older models reject `effort` and adaptive thinking outright, so both are
  // opt-out per catalogue entry rather than sent unconditionally.
  if (entry?.effort !== false) {
    params.output_config = { effort };
  }
  // Reasoning is surfaced live in the UI, so opt in to summaries explicitly —
  // the default returns thinking blocks with empty text.
  if (entry?.thinking !== false) {
    params.thinking = { type: 'adaptive', display: 'summarized' };
  }

  const stream = client.messages.stream(params, { signal });

  const blockTypes = new Map();
  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      blockTypes.set(event.index, event.content_block.type);
      if (event.content_block.type === 'tool_use') {
        yield { type: 'tool_call_start', id: event.content_block.id, name: event.content_block.name };
      }
    } else if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') yield { type: 'text', delta: event.delta.text };
      else if (event.delta.type === 'thinking_delta') yield { type: 'thinking', delta: event.delta.thinking };
    }
  }

  const final = await stream.finalMessage();

  const toolCalls = final.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input ?? {} }));

  yield {
    type: 'done',
    stopReason: final.stop_reason,
    toolCalls,
    raw: { anthropic: final.content },
    /**
     * `input` stays the **whole** prompt, cached parts included, because that is
     * what the context gauge and the compaction trigger read: how much of the
     * window this turn actually occupied. Netting the cache off here would make
     * a long conversation look like it had room it does not have.
     *
     * The two cached figures ride alongside as subsets of it, so pricing can
     * take them at their real rates — a cache read costs about a tenth of an
     * input token and a cache write about a quarter more. They used to be summed
     * into `input` and left there, and `estimateCost` then charged the full rate
     * for all of it: on a well-cached agentic conversation the usage page
     * reported several times what the turn had really cost.
     */
    usage: {
      input: (final.usage?.input_tokens || 0) + (final.usage?.cache_read_input_tokens || 0) +
        (final.usage?.cache_creation_input_tokens || 0),
      output: final.usage?.output_tokens || 0,
      cacheRead: final.usage?.cache_read_input_tokens || 0,
      cacheWrite: final.usage?.cache_creation_input_tokens || 0,
    },
  };
}

/** Exposed so the suite can assert what Claude is actually handed. */
export const __testing = { toMessages, withCachePoint };
