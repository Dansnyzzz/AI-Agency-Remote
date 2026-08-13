/**
 * When a document the assistant just made opens itself, and when it does not.
 *
 * The opening is the easy half. The restraint is the feature: a panel that
 * slides in every time the assistant saves, over whatever somebody was reading,
 * on a phone, while an approval is waiting, is the version people turn off. So
 * every rule that holds it back gets a case here.
 *
 *   node test/autopreview.test.mjs
 */
import { shouldAutoPreview } from '../public/js/autopreview.js';

let failures = 0;
const section = (name) => console.log(`\n\x1b[1m${name}\x1b[0m`);
function check(what, ok, note = '') {
  if (!ok) failures += 1;
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'}  ${what}${note ? ` — ${note}` : ''}`);
}

/** A wide desktop, nothing open, nothing in the way. */
const ready = {
  prefOn: true,
  alreadyOpened: false,
  width: 1440,
  showingId: null,
  fileId: 'f1',
  approving: false,
  elsewhere: false,
};

const ask = (patch) => shouldAutoPreview({ ...ready, ...patch });

section('the ordinary case');
{
  const result = ask({});
  check('a new document opens itself', result.open, result.why);
}

section('and every reason it should not');
{
  const off = ask({ prefOn: false });
  check('the setting is off', !off.open);
  check('  and says so', /settings/.test(off.why), off.why);

  // The rule that stops it being a fight: closing it has to keep meaning
  // "not now" for the rest of the turn.
  const again = ask({ alreadyOpened: true });
  check('something already opened this turn', !again.open);
  check('  and says so', /already opened/.test(again.why), again.why);

  // Below 900px the panel is the whole window — burying the conversation
  // being written is an interruption, not a preview.
  const phone = ask({ width: 780 });
  check('the screen is too narrow for two columns', !phone.open);
  check('  and says so', /narrow/.test(phone.why), phone.why);
  check('  900 exactly is still too narrow', !ask({ width: 900 }).open);
  check('  901 is wide enough', ask({ width: 901 }).open);

  const waiting = ask({ approving: true });
  check('an approval is waiting to be read', !waiting.open, waiting.why);

  const shelf = ask({ elsewhere: true });
  check('a shelf or a project page has the screen', !shelf.open, shelf.why);

  // Taking away what somebody chose to look at, to show them something they
  // have not asked about yet, is the difference between helpful and rude.
  const busy = ask({ showingId: 'other-file' });
  check('the user is reading a different file', !busy.open);
  check('  and says so', /reading something else/.test(busy.why), busy.why);
}

section('a rewrite is not a new document');
{
  const same = ask({ showingId: 'f1', fileId: 'f1' });
  check('the file on screen being rewritten does not re-open it', !same.open);
  check('  because it is already there', /already showing/.test(same.why), same.why);
}

section('the reasons are in a useful order');
{
  // Precedence matters: the answer to "why did nothing happen" should name the
  // thing the user can act on. The setting outranks everything, because if it
  // is off nothing else is relevant.
  check(
    'the setting is checked before anything else',
    /settings/.test(ask({ prefOn: false, width: 300, approving: true, alreadyOpened: true }).why),
  );
  check(
    'and "once per turn" before the transient reasons',
    /already opened/.test(ask({ alreadyOpened: true, approving: true, showingId: 'x' }).why),
  );
  // Otherwise a rewrite arriving on a narrow screen would report the width,
  // when the caller needs to know it is the same file so it can refresh it.
  check(
    'a rewrite is distinguishable from an ordinary refusal',
    /already showing/.test(ask({ showingId: 'f1', fileId: 'f1' }).why),
  );
}

section('nothing is assumed about the caller');
{
  // `approving` and `elsewhere` default to false so a caller that has neither
  // concept still gets sensible behaviour rather than a silent `undefined`.
  const bare = shouldAutoPreview({
    prefOn: true,
    alreadyOpened: false,
    width: 1200,
    showingId: null,
    fileId: 'f9',
  });
  check('the optional conditions default to "not blocking"', bare.open, bare.why);

  check('a missing preference is treated as off, not as on', !shouldAutoPreview({ width: 1200 }).open);
}

console.log(
  failures ? `\n\x1b[31m${failures} check(s) failed.\x1b[0m\n` : '\n\x1b[32mAll auto-preview checks passed.\x1b[0m\n',
);
process.exit(failures ? 1 : 0);
