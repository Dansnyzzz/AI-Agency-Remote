/**
 * Bounded concurrency, in one place.
 *
 * Two callers need exactly this and for exactly the same reason — the agent
 * loop running a turn's tool calls, and a sub-agent running its own — and they
 * cannot share it through either of their modules without a cycle: the agent
 * loop imports the cloud tools, which import the sub-agents, which would import
 * the agent loop back.
 */

/**
 * How many tool calls may be in flight at once.
 *
 * There was no ceiling: every call the model made in one turn started at the
 * same instant. That is fine for three `web_fetch`es and genuinely dangerous for
 * fifteen `run_command`s, which is fifteen shells starting together on somebody
 * else's laptop — and there is no backpressure anywhere else in the chain to
 * catch it. Parallelism is still most of why a turn feels fast, so this is a
 * limit rather than a queue: four is comfortably more than a model asks for in
 * the ordinary case, and it holds the pathological one to something a machine
 * can survive.
 */
export const MAX_PARALLEL_TOOLS = 4;

/**
 * Run every item, at most `limit` at a time, and return the results in the
 * order they were requested.
 *
 * Order matters more than it looks: a tool result has to line up with the call
 * it answers, and every provider rejects a batch where they do not.
 */
export async function mapWithLimit(items, limit, worker) {
  const out = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}
