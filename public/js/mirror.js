/**
 * The same conversation, open in two places.
 *
 * One agent loop per conversation is not negotiable — two tabs both appending to
 * one transcript produces a conversation with its turns shuffled together, which
 * is why the run lease exists and why a second tab is refused with a 409. That
 * refusal is correct and it is also, from where the person is sitting, a bug:
 * they opened their own conversation on their laptop while their phone was
 * mid-answer, and it sat there saying nothing.
 *
 * So the tab that holds the run narrates it, and the others listen. The follower
 * never sends anything, never holds the lease, and never writes to the
 * transcript — it draws what it is told and reloads properly when the run ends,
 * which is the point at which the database is the truth again.
 *
 * `BroadcastChannel` is same-origin and in-browser: nothing here crosses the
 * network, so this costs no requests and cannot leak between accounts. It is
 * also why this only helps tabs on one device — a phone and a laptop are still
 * two browsers, and the reload-on-finish is what serves them.
 */
const CHANNEL = 'ai-remote-run';

/** Older browsers, and any context where the API is unavailable, simply opt out. */
const supported = typeof BroadcastChannel === 'function';

let channel = null;
const open = () => {
  if (!supported) return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL);
  return channel;
};

/**
 * Say what just happened in this run.
 *
 * Called from the owning tab for every stream event. Deliberately fire-and-
 * forget and deliberately unacknowledged: a follower that missed something
 * reloads at the end anyway, and making the owner wait on its audience would put
 * the interface of a tab nobody is watching in the path of the one they are.
 */
export function narrate(chatId, event, data) {
  const bus = open();
  if (!bus || !chatId) return;
  try {
    bus.postMessage({ chatId, event, data });
  } catch {
    // A payload that will not structured-clone — a DOM node caught in a closure,
    // say. Losing one frame of narration is not worth breaking the run for.
  }
}

/**
 * Listen to a run happening in another tab.
 *
 * @param chatId    only events for this conversation are passed on.
 * @param onEvent   (event, data) for each frame.
 * @returns a function that stops listening. Call it when the view changes;
 *   a follower left subscribed to a conversation nobody is looking at would
 *   quietly redraw it forever.
 */
export function follow(chatId, onEvent) {
  const bus = open();
  if (!bus || !chatId) return () => {};

  const listener = (message) => {
    const frame = message?.data;
    if (!frame || frame.chatId !== chatId) return;
    onEvent(frame.event, frame.data);
  };
  bus.addEventListener('message', listener);
  return () => bus.removeEventListener('message', listener);
}

export const __testing = { CHANNEL, supported };
