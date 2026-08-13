import { getStore, isServerless } from './store/index.js';

/**
 * The live screen, pushed rather than polled.
 *
 * The old path sent every frame through the database and had the browser ask
 * for one twice a second. That put a write and a read on the critical path of
 * something that should be a pipe, and capped the mirror at the poll interval
 * no matter how fast frames arrived. Here a frame goes straight from the worker
 * to whichever tabs are watching.
 *
 * Frames are deliberately **not** persisted when the server runs locally. They
 * are worthless a second later, and writing a 90KB blob ten times a second to
 * keep a record nobody reads is pure cost. On Vercel the story is different —
 * each request may land on a different instance, so there the last frame is
 * stored and the browser falls back to polling.
 */

const rooms = new Map(); // userId -> { clients:Map<res,{hd}>, latest, polledAt, polledHd }

/**
 * How long a frame nobody is watching stays in memory.
 *
 * A frame is ~90KB of base64 and is worthless a second later, but the cleanup
 * only fired when there had never been one — so in practice a room, and its
 * frame, was retained for every user who had ever opened the panel, for as long
 * as the process lived. On a machine left running for a week that is a slow leak
 * of somebody's screenshots.
 */
const FRAME_TTL_MS = 60_000;

function room(userId) {
  let found = rooms.get(userId);
  if (!found) {
    // A Map rather than a Set: each watcher carries what it is asking for, and
    // one tab looking at the panel full screen must not make every other tab
    // pay for the pixels.
    found = { clients: new Map(), latest: null, polledAt: 0, polledHd: false };
    rooms.set(userId, found);
  }
  return found;
}

/**
 * Whether anybody watching wants the high-resolution stream.
 *
 * Any one of them is enough: the frame is shared, and a small panel showing a
 * bigger picture than it needs looks fine, while a big one showing a smaller
 * picture than it needs is the blur this exists to fix.
 */
function wantsHd(here) {
  for (const [, wants] of here.clients) if (wants.hd) return true;
  return here.polledHd && Date.now() - here.polledAt < 5000;
}

/** Drop rooms with nobody in them and nothing recent to show. */
function sweep() {
  const now = Date.now();
  for (const [userId, here] of rooms) {
    if (here.clients.size) continue;
    if (now - here.polledAt < FRAME_TTL_MS) continue;
    if (here.latest && now - here.latest.at < FRAME_TTL_MS) continue;
    rooms.delete(userId);
  }
}

// Unref'd, so it never holds the process open — this is housekeeping, not work.
const sweeper = setInterval(sweep, FRAME_TTL_MS);
sweeper.unref?.();

/** Forget everything held for one account — signing out, or closing the sandbox. */
export function forget(userId) {
  const here = rooms.get(userId);
  if (!here) return;
  here.latest = null;
  if (!here.clients.size) rooms.delete(userId);
}

/** Someone is watching if a tab holds the stream open, or polled very recently. */
function watched(userId) {
  const here = room(userId);
  return here.clients.size > 0 || Date.now() - here.polledAt < 5000;
}

/**
 * Take a frame from a source and hand it to everyone watching.
 *
 * Returns whether anyone is — which is what tells the worker to stop capturing.
 */
export async function publish(userId, frame, meta = {}) {
  const here = room(userId);
  here.latest = { frame, meta, at: Date.now() };

  // A serverless deployment has no shared memory between instances, so the
  // frame has to go somewhere both sides can see.
  if (isServerless()) {
    await getStore().putScreen(userId, { frame, meta });
    return { watching: await getStore().isWatched(userId), hd: false };
  }

  const message = `data: ${JSON.stringify({ frame, meta })}\n\n`;
  for (const [client] of here.clients) {
    try {
      client.write(message);
    } catch {
      here.clients.delete(client);
    }
  }

  return { watching: watched(userId), hd: wantsHd(here) };
}

/** Hold a connection open and stream frames down it until the tab goes away. */
export function subscribe(userId, req, res, { hd = false } = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Nginx and friends buffer event streams into uselessness without this.
    'X-Accel-Buffering': 'no',
  });

  const here = room(userId);
  here.clients.set(res, { hd });

  // Whatever is on screen right now, so a tab that just opened is not staring
  // at nothing until the next repaint.
  if (here.latest) {
    res.write(`data: ${JSON.stringify({ frame: here.latest.frame, meta: here.latest.meta })}\n\n`);
  } else {
    res.write(': waiting for the first frame\n\n');
  }

  // Proxies drop a silent connection; a comment line keeps it alive and is
  // ignored by EventSource.
  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* the close handler will clean up */
    }
  }, 15_000);

  const done = () => {
    clearInterval(heartbeat);
    here.clients.delete(res);
    // The sweeper handles the rest: a room whose last frame is still fresh is
    // worth keeping for a moment, in case the tab is being reloaded rather than
    // closed. It just must not be kept forever, which is what used to happen.
    if (!here.clients.size && !here.latest) rooms.delete(userId);
  };

  // On the response, not the request: a request emits 'close' as soon as its
  // body has been consumed, which would tear the stream down immediately.
  res.on('close', done);
  res.on('error', done);
}

/**
 * The polling fallback, for a browser without EventSource and for serverless
 * where the frame came from another instance entirely.
 */
export async function poll(userId, { hd = false } = {}) {
  const here = room(userId);
  here.polledAt = Date.now();
  here.polledHd = hd;

  if (isServerless()) {
    await getStore().markWatching(userId);
    const stored = await getStore().getScreen(userId);
    return {
      frame: stored?.frame ?? null,
      meta: stored?.meta ?? {},
      updatedAt: stored?.updated_at ?? null,
    };
  }

  return {
    frame: here.latest?.frame ?? null,
    meta: here.latest?.meta ?? {},
    updatedAt: here.latest ? new Date(here.latest.at).toISOString() : null,
  };
}

export const isWatching = watched;
