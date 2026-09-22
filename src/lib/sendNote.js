// EVERY FAILURE NOTE THIS PROJECT WRITES IS BUILT HERE.
//
// One line of text has now caused three bugs in three directions, because the
// Worker WROTE it in eight places and the night check MATCHED it in one, with
// nothing tying them together:
//
//   * The on-demand queue printed "FAILED {...}" for a real throw AND for
//     `nothing to send: no ship is missing its Ordering Schedule`, the
//     healthiest outcome a chase has. The watchdog matched '%FAILED%', so
//     every quiet chase raised a CRITICAL.
//   * Narrowing that pattern to '%send FAILED:%' on 22 Sep killed the false
//     alarm and silently killed the real one with it, because that note said
//     "FAILED" and never "send FAILED:".
//   * The same narrowing left FOUR MORE shapes unmatched, measured: three
//     `send THREW:` sites — which is how a transport exception actually
//     surfaces — and the per-ship `NOT SENT` line. The night check could see
//     four of the eight ways this project can fail to send.
//
// So no caller writes the words any more. They call these, the mark lives in
// one constant, and watchdog.js builds its SQL from the same constant. A
// failure shape the reader cannot see is now impossible to write by accident.
export const SEND_FAILED_MARK = 'send FAILED:';

// A send that returned without sending. `what` names the send, e.g. 'digest',
// 'weekly', 'weekly supervisor'.
export function sendFailure(what, detail) {
  const d = typeof detail === 'string' ? detail : JSON.stringify(detail);
  return `${what} ${SEND_FAILED_MARK} ${d}`;
}

// A send that threw. THIS IS STILL A SEND FAILURE and must carry the mark —
// the three sites that wrote "send THREW:" instead were invisible to the night
// check. The word THREW stays, because a human reading the log wants to know
// which of the two it was.
export function sendThrew(what, e) {
  return `${what} ${SEND_FAILED_MARK} THREW ${String((e && e.message) || e).slice(0, 300)}`;
}

// What one on-demand queue row did, in one line for ingest_log.
//
// `lines` carries one entry per ship actually attempted. When it is empty no
// ship was attempted at all, and that has two unrelated causes which must not
// share a word: a throw before the loop, and there being nothing to do.
export function onDemandOutcome({ lines = [], result = {} }) {
  if (lines.length) {
    const joined = lines.join(' | ');
    // A PER-SHIP FAILURE IS A SEND FAILURE. A single-ship queue row always
    // produces exactly one line, so a real transport error on an on-demand
    // send wrote "Journey -> jr@x: NOT SENT ..." — a note carrying no mark,
    // which the night check could not match and therefore never reported.
    return lines.some((l) => /NOT SENT/.test(l)) ? `${SEND_FAILED_MARK} ${joined}` : joined;
  }
  if (result.sent) return 'sent';
  // A throw is a failure. So is an unexplained non-send: when we cannot say
  // why nothing went out, the safe reading is that something broke.
  if (result.threw || !result.reason) return `${SEND_FAILED_MARK} ${JSON.stringify(result)}`;
  return `nothing to do - ${result.reason}`;
}
