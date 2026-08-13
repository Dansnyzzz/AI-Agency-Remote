import { GoogleGenAI } from '@google/genai';

/** Gemini accepts an OpenAPI subset — unknown JSON Schema keywords are rejected. */
function toGeminiSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const allowed = ['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable', 'format'];
  const out = {};
  for (const key of allowed) {
    if (!(key in schema)) continue;
    if (key === 'properties') {
      out.properties = Object.fromEntries(
        Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]),
      );
    } else if (key === 'items') {
      out.items = toGeminiSchema(schema.items);
    } else {
      out[key] = schema[key];
    }
  }
  return out;
}

/**
 * Attachments, in Gemini's shape.
 *
 * `inlineData` covers images and PDFs alike — Gemini reads a PDF directly, so
 * there is nothing special to do for it beyond passing the right mime type.
 */
function attachmentParts(parts) {
  const out = [];
  for (const part of parts) {
    if (part.type === 'text') out.push({ text: part.text });
    else if (part.type === 'image') out.push({ inlineData: { mimeType: part.mime, data: part.data } });
    else if (part.type === 'document') {
      out.push({ inlineData: { mimeType: 'application/pdf', data: part.data } });
    }
  }
  return out;
}

function toContents(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = [...attachmentParts(m.parts || [])];
      if (m.text) parts.push({ text: m.text });
      out.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
    } else if (m.role === 'assistant') {
      const parts = [];
      if (m.text) parts.push({ text: m.text });
      for (const c of m.toolCalls || []) {
        // The signature goes back exactly as it came. Gemini 3 treats it as
        // part of the call: without it, tool use is explicitly degraded and the
        // API says so on every turn that replays one.
        parts.push({
          functionCall: { name: c.name, args: c.input ?? {} },
          ...(c.signature ? { thoughtSignature: c.signature } : {}),
        });
      }
      if (parts.length) out.push({ role: 'model', parts });
    } else if (m.role === 'tool') {
      out.push({
        role: 'user',
        parts: (m.results || []).map((r) => ({
          functionResponse: {
            name: r.name,
            response: r.isError ? { error: String(r.content ?? '') } : { result: String(r.content ?? '') },
          },
        })),
      });
    }
  }
  return out;
}

export async function* streamGoogle({
  apiKey,
  model,
  system,
  messages,
  tools,
  maxTokens = 32000,
  signal,
}) {
  const ai = new GoogleGenAI({ apiKey });

  const config = {
    maxOutputTokens: maxTokens,
    ...(system ? { systemInstruction: system } : {}),
    ...(tools?.length
      ? {
          tools: [
            {
              functionDeclarations: tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: toGeminiSchema(t.parameters),
              })),
            },
          ],
        }
      : {}),
    thinkingConfig: { includeThoughts: true },
    abortSignal: signal,
  };

  const stream = await ai.models.generateContentStream({ model, contents: toContents(messages), config });

  const toolCalls = [];
  let usage = { input: 0, output: 0 };
  let stopReason = null;
  /** The most recent thought signature seen, for the call it belongs to. */
  let signature = null;

  for await (const chunk of stream) {
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) stopReason = candidate.finishReason;
    if (chunk.usageMetadata) {
      usage = {
        input: chunk.usageMetadata.promptTokenCount || 0,
        output:
          (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
      };
    }

    for (const part of candidate?.content?.parts || []) {
      /**
       * The signature Gemini expects to see again.
       *
       * From Gemini 3 on, a part carrying a function call also carries a
       * `thoughtSignature` — an opaque token standing for the reasoning that
       * produced the call. Send the call back on the next turn without it and
       * the API says so: *"Function call is missing a thought_signature in
       * functionCall parts. This is required for tools to work correctly."*
       * The turn still completes, which is what makes it easy to miss, and the
       * model works from a redacted version of its own reasoning.
       *
       * It arrives on the same part as the call, but not always in the same
       * chunk of the stream, so the last one seen is carried forward.
       */
      if (part.thoughtSignature) signature = part.thoughtSignature;

      if (part.text) {
        // Gemini marks summarised reasoning with `thought: true` on the part.
        yield part.thought ? { type: 'thinking', delta: part.text } : { type: 'text', delta: part.text };
      }
      if (part.functionCall) {
        const id = part.functionCall.id || `gcall_${toolCalls.length}_${part.functionCall.name}`;
        toolCalls.push({
          id,
          name: part.functionCall.name,
          input: part.functionCall.args ?? {},
          // Stored with the call, so it survives into the database and comes
          // back on the resumed turn as well as on the next step.
          ...(part.thoughtSignature || signature ? { signature: part.thoughtSignature || signature } : {}),
        });
        signature = null;
        yield { type: 'tool_call_start', id, name: part.functionCall.name };
      }
    }
  }

  yield { type: 'done', stopReason, toolCalls, usage };
}

/** Exposed so the suite can assert what Gemini is actually handed. */
export const __testing = { toContents };
