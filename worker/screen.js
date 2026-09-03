/**
 * The live screen — one stream, several possible sources.
 *
 * The browser sandbox and the desktop both want to show the user what is
 * happening, but only one of them can be on screen at a time. Rather than let
 * them fight over the panel, each **claims** the stream and the previous holder
 * is told to stop. The user always sees whatever the assistant is actually
 * working on, and an idle source never burns CPU on frames nobody sees.
 *
 * `watching` comes back from the sink on every frame: the browser polling or
 * subscribing for frames *is* the signal that someone is looking. When nobody
 * is, sources idle down to nothing until the next deliberate action.
 */

let sink = null;
let watching = true; // optimistic: the opening seconds are when people look
let active = null; // { name, stop }
let lastWatchedAt = Date.now();

/**
 * How long frames may keep failing before this decides nobody is watching.
 *
 * Long enough that a reconnect, a redeploy or a few seconds of bad wifi does not
 * stop a live session; short enough that a worker whose server has gone away
 * stops capturing the screen rather than doing it indefinitely.
 */
const UNREACHABLE_GRACE_MS = 30_000;
/** What the people watching have asked for — currently just "show it big". */
let preference = { hd: false };

/**
 * Where frames go. The worker posts them to the server; an all-in-one local run
 * hands them straight to the hub. Neither source needs to know which.
 */
export function setFrameSink(fn) {
  sink = fn;
}

export const isWatched = () => watching;
export const activeSource = () => active?.name || null;

/**
 * Send a frame. Returns false when nobody is watching, which is a source's cue
 * to stop capturing until it has something new to show.
 */
export async function publishFrame(payload) {
  if (!sink) return false;
  try {
    const reply = await sink(payload);
    watching = reply?.watching !== false;
    // The panel says what it wants back down the same pipe the frames go up:
    // full screen on a 2K monitor needs more pixels than a 340px rail does, and
    // sending those to the rail all the time would be bandwidth for nothing.
    preference = { hd: !!reply?.hd };
    if (watching) lastWatchedAt = Date.now();
    return watching;
  } catch {
    /**
     * A dropped frame is never worth failing the action that produced it — but
     * it must not read as "somebody is still watching" for ever either.
     *
     * This returned the *previous* `watching` value, so once the server became
     * unreachable the answer stayed `true` permanently: nothing ever cleared
     * it, the source never got its cue to stop, and the capture loop went on
     * grabbing the whole desktop several times a second for a viewer that was
     * not there and a server that could not be reached.
     *
     * The grace window is what keeps a single blip from stopping a live
     * session. Past it, sustained failure is treated as nobody watching, which
     * is both the safe answer and almost certainly the true one — and the next
     * frame that does get through sets it straight back.
     */
    if (watching && Date.now() - lastWatchedAt > UNREACHABLE_GRACE_MS) watching = false;
    return watching;
  }
}

/** What the watchers asked for, as of the last frame that got through. */
export const watcherPreference = () => preference;

/**
 * Take over the screen. The previous source is stopped first, so switching from
 * the browser to a desktop app does not leave two capture loops running.
 */
export async function claim(name, stop) {
  if (active && active.name !== name) {
    try {
      await active.stop();
    } catch {
      /* a source that cannot stop cleanly must not block the new one */
    }
  }
  active = { name, stop };
  // A new source is a deliberate act, so assume the user wants to see it and
  // let the first frame's reply correct us if not.
  watching = true;
}

export function release(name) {
  if (active?.name === name) active = null;
}

/** How long the panel has been closed, for sources deciding whether to idle. */
export const unwatchedFor = () => Date.now() - lastWatchedAt;
