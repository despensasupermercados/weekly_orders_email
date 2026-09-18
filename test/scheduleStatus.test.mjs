// node test/scheduleStatus.test.mjs
// "You are missing this file, do it first." The point pinned here is that the
// ask names WHAT went wrong last time, from cims-hon's own ingest-log lines as
// they appeared on 9-13 Sep 2026, and that the ships who cannot be helped by
// this ask (Azamara, hulls not in service) are never asked.

import { judgeShips, classifyNote, STATUS, needsSchedule, CREW_LINE, mappedShip } from '../src/lib/scheduleStatus.js';
import assert from 'node:assert';

assert.equal(classifyNote('1 spreadsheet(s) — UPDATED _ Xcel Ordering Schedule.xls: schedule — could not map to a known ship, skipped'), STATUS.UNMATCHED);
assert.equal(classifyNote('1 spreadsheet(s) — CELEBRITY MILLENNIUM 2026 ORDERING SCHEDULE-HOTEL BIWEEKLY HOTEL.xlsx → Millennium (via filename): 0 DG3 orders (0 upcoming) from 0 rows'), STATUS.UNREADABLE);
assert.equal(classifyNote('no spreadsheet attachment; 1 attachments: Updated Ordering Schedule CEL Ascent.png:image/png'), STATUS.IMAGE);
assert.equal(classifyNote('no spreadsheet attachment; 0 attachments'), STATUS.NOFILE);
assert.equal(classifyNote('1 spreadsheet(s) — Radiance Ordering Schedule UPDATED 07-24-2026 (1).xls → Radiance (via filename): 40 DG3 orders (14 upcoming) from 1125 rows'), null);

const TODAY = '2026-09-16';
const ships = [
  { ship: 'Radiance', address: 'rd_printerspecialist@rccl.com' },
  { ship: 'Allure', address: 'al_printerspecialist@rccl.com' },
  { ship: 'Millennium', address: 'ml_printer@celebrity.com' },
  { ship: 'Ascent', address: 'at_printer@celebrity.com' },
  { ship: 'Xcel', address: 'xc_printer@celebrity.com' },
  { ship: 'Beyond', address: 'by_printer@celebrity.com' },
  { ship: 'Quest', address: 'qs_pm@azamaraships.com' },
  { ship: 'Legend', address: 'le_printerspecialist@rccl.com' },
];
const schedule = [
  { ship: 'Radiance', upcoming: 14, last_due: '2027-03-09' },
  { ship: 'Allure', upcoming: 0, last_due: '2026-03-11' },
  { ship: 'Legend', upcoming: 6, last_due: '2026-12-24' },
];
const attempts = [
  { sender: 'rd_printerspecialist@rccl.com', ts: '2026-09-13 04:18:40', note: 'Radiance Ordering Schedule ... → Radiance (via filename): 40 DG3 orders (14 upcoming) from 1125 rows' },
  { sender: 'ml_printer@celebritycruises.com', ts: '2026-09-13 00:20:47', note: 'CELEBRITY MILLENNIUM 2026 ORDERING SCHEDULE.xlsx → Millennium (via filename): 0 DG3 orders (0 upcoming) from 0 rows' },
  { sender: 'AT_Printer@celebrity.com', ts: '2026-09-12 16:15:26', note: 'no spreadsheet attachment; 1 attachments: Updated Ordering Schedule CEL Ascent.png:image/png' },
  { sender: 'xc_printer@celebrity.com', ts: '2026-09-09 18:01:37', note: 'UPDATED _ Xcel Ordering Schedule.xls: schedule — could not map to a known ship, skipped' },
  { sender: 'al_printerspecialist@rccl.com', ts: '2026-09-09 21:49:18', note: 'Allure Ordering Schedule.xls → Allure: 15 DG3 orders (0 upcoming) from 563 rows' },
];
const out = judgeShips({ ships, schedule, attempts, today: TODAY });
const by = Object.fromEntries(out.map((s) => [s.ship, s]));

assert.equal(by.Radiance.status, STATUS.OK, 'due dates ahead: fine');
assert.equal(by.Allure.status, STATUS.STALE, 'loaded, every due date passed: stale');
assert.equal(by.Allure.last_due, '2026-03-11');
// Millennium's mailbox in the log (celebritycruises.com) differs from the one
// in FLEET_MAP (celebrity.com): the match falls back to the ship's name in the
// note rather than losing the attempt.
assert.equal(by.Millennium.status, STATUS.UNREADABLE, `file read as 0 rows: ${by.Millennium.detail}`);
assert.equal(by.Ascent.status, STATUS.IMAGE, 'a screenshot is not the file (sender matched case-insensitively)');
assert.equal(by.Xcel.status, STATUS.UNMATCHED, 'a file that named no ship');
assert.equal(by.Beyond.status, STATUS.NEVER, 'nothing loaded, nothing on record');
assert.ok(!by.Quest, 'Azamara ships are never asked for an ordering schedule - theirs is Ray\'s MLS');
assert.equal(by.Legend && by.Legend.status, STATUS.OK, 'Legend is in service and has a schedule: judged, and fine');

const ask = needsSchedule(out).map((s) => s.ship).sort();
assert.deepEqual(ask, ['Allure', 'Ascent', 'Beyond', 'Millennium', 'Xcel']);
for (const s of needsSchedule(out)) {
  if (s.status !== STATUS.STALE) assert.ok(CREW_LINE[s.status], `${s.status} has a crew line`);
}
// The crew lines say what to do, in short words, and never say "schedule
// ingest" or "parse".
for (const line of Object.values(CREW_LINE)) assert.ok(!/ingest|parse|null|row/i.test(line), line);

console.log('ok - schedule status: each ship is told why its last attempt failed, Azamara and');
console.log('     out-of-service hulls are never asked, and the crew lines carry no jargon');


// REVIEW OF 17 Sep 2026. (1) A line cims-hon mapped to a ship belongs to that
// ship, whoever sent it; (2) a PDF is a wrong file, not "no file"; (3) the
// mapping arrow is read exactly.
{
  assert.equal(mappedShip('1 spreadsheet(s) — Beyond Ordering Schedule Aug 19.xls → Beyond (via filename): 29 DG3 orders (9 upcoming) from 988 rows'), 'beyond');
  assert.equal(mappedShip('1 spreadsheet(s) — SISO_Ordering Schedule.xls → Independence (via sender ID): 24 DG3 orders'), 'independence');
  assert.equal(mappedShip('no spreadsheet attachment; 1 attachments: x.png:image/png'), null);
  assert.equal(classifyNote('no spreadsheet attachment; 1 attachments: Ascent Ordering Schedule.pdf:application/pdf'), STATUS.WRONGTYPE);
  assert.ok(CREW_LINE[STATUS.WRONGTYPE], 'the crew line exists for it');
  const two = [
    { ship: 'Ascent', address: 'at_printer@celebrity.com' },
    { ship: 'Beyond', address: 'by_printer@celebrity.com' },
  ];
  const attempts = [
    // Ascent's printer forwarded Beyond's file; cims-hon mapped it to Beyond and it read empty.
    { sender: 'at_printer@celebrity.com', ts: '2026-09-16 18:00:00', note: '1 spreadsheet(s) — Beyond Ordering Schedule.xls → Beyond (via filename): 0 DG3 orders (0 upcoming) from 0 rows' },
    { sender: 'at_printer@celebrity.com', ts: '2026-09-12 16:15:26', note: 'no spreadsheet attachment; 1 attachments: Updated Ordering Schedule CEL Ascent.png:image/png' },
  ];
  const out = judgeShips({ ships: two, schedule: [], attempts, today: '2026-09-17' });
  const by = Object.fromEntries(out.map((s) => [s.ship, s]));
  assert.equal(by.Beyond.status, STATUS.UNREADABLE, 'the mapped line is Beyond\'s attempt');
  assert.equal(by.Ascent.status, STATUS.IMAGE, 'Ascent keeps its own last attempt, the picture');
  console.log('ok - schedule status: a line mapped to a ship is that ship\'s attempt; a PDF is the wrong file, not no file');
}
