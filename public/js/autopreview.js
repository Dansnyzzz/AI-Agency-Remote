/**
 * Whether a document the assistant just made should open itself.
 *
 * The reason to ask for a report is to read it, and the card in the transcript
 * is one more press between the two — so by default it opens in the panel
 * beside the conversation without being asked for.
 *
 * Doing that naively is worse than not doing it at all, and the rules that keep
 * it from becoming a thing people switch off are the whole substance of the
 * feature. They live here, as one function with no DOM in it, so they can be
 * stated once and tested directly rather than inferred from a stream handler.
 */

/**
 * @param prefOn        the account's setting. Off means off, always.
 * @param alreadyOpened something has already opened automatically this turn.
 * @param width         the window's width in pixels.
 * @param showingId     the file id in the panel right now, or null.
 * @param fileId        the file being offered.
 * @param approving     an approval prompt is waiting for an answer.
 * @param elsewhere     a shelf or a project page has the screen.
 * @returns `{ open: boolean, why: string }` — the reason is for the test and
 *   for anyone reading a log, and it is why this returns an object rather than
 *   a bare boolean. "It did not open" is a support question; "it did not open
 *   because you closed it earlier this turn" is an answer.
 */
export function shouldAutoPreview({
  prefOn,
  alreadyOpened,
  width,
  showingId,
  fileId,
  approving = false,
  elsewhere = false,
}) {
  if (!prefOn) return { open: false, why: 'turned off in settings' };

  // Once per turn, exactly like the plan panel. A panel that reappears every
  // time the assistant saves is a fight, not a convenience — and closing it is
  // how somebody says "not now", which has to keep meaning that.
  if (alreadyOpened) return { open: false, why: 'already opened once this turn' };

  // Below this the panel is the whole window (see the media query in app.css),
  // so opening one mid-turn buries the conversation being written.
  if (width <= 900) return { open: false, why: 'the screen is too narrow to show both' };

  // That prompt is the thing to read.
  if (approving) return { open: false, why: 'an approval is waiting' };

  // The shelves and a project page take the place of the conversation. A
  // document sliding in beside one is an interruption of something else.
  if (elsewhere) return { open: false, why: 'another page has the screen' };

  // The same file, rewritten. Not a new thing to look at — the panel re-reads
  // it in place, which is a different action and the caller's job.
  if (showingId && showingId === fileId) return { open: false, why: 'already showing this file' };

  // Something else is open in there. Since nothing has opened automatically
  // this turn, it is what the user chose to look at, and taking that away to
  // show them something they have not asked about yet is the difference
  // between helpful and rude.
  if (showingId) return { open: false, why: 'the user is reading something else' };

  return { open: true, why: 'a new document, and nothing in the way' };
}
