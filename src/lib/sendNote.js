// THE FAILURE MARKER, DEFINED ONCE, FOR BOTH SIDES.
//
// This one line of text has caused two bugs in two directions because the
// Worker WROTE it in one place and the night check MATCHED it in another, and
// nothing tied the two together:
//
//   * The on-demand queue printed "FAILED {...}" for a real throw AND for
//     `nothing to send: no ship is missing its Ordering Schedule`, the
//     healthiest outcome a chase has. The watchdog matched '%FAILED%', so
//     every quiet chase raised a CRITICAL.
//   * Narrowing that pattern to '%send FAILED:%' on 22 Sep killed the false
//     alarm and silently killed the real one with it, because this note said
//     "FAILED" and never "send FAILED:".
//
// So the mark lives here, the writer uses it, and the reader's SQL is built
// from it. They cannot drift apart again without this file changing.
export const SEND_FAILED_MARK = 'send FAILED:';

// What one on-demand queue row did, in one line for ingest_log.
//
// `lines` carries one entry per ship actually attempted. When it is empty no
// ship was attempted at all, and that has two unrelated causes which must not
// share a word: a throw before the loop, and there being nothing to do.
export function onDemandOutcome({ lines = [], result = {} }) {
  if (lines.length) return lines.join(' | ');
  if (result.sent) return 'sent';
  // A throw is a failure. So is an unexplained non-send: when we cannot say
  // why nothing went out, the safe reading is that something broke.
  if (result.threw || !result.reason) return `${SEND_FAILED_MARK} ${JSON.stringify(result)}`;
  return `nothing to do - ${result.reason}`;
}
