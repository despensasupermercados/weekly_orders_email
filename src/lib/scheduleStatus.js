// Does each ship have an Ordering Schedule we can use, and if not, why not.
//
// Miguel, 16 Sep 2026: "if that's the case, the email should say: you are
// missing this file, do it first." A ship with no schedule loaded gets its
// dates from open orders, which is weaker evidence than the cruise line's own
// due dates, and the crew can fix that themselves in one email. So the weekly
// email tells them - and tells them WHAT went wrong with the last attempt,
// because "send your schedule" to a ship that already sent a screenshot of it
// is how a request gets ignored.
//
// The evidence is cims-hon's own ingest log for obp@cims.work, which names the
// file, the ship it mapped to and how many DG3 orders it read. Seen 9-13 Sep
// 2026, one line each:
//   "... Radiance Ordering Schedule UPDATED 07-24-2026 (1).xls -> Radiance
//        (via filename): 40 DG3 orders (14 upcoming) from 1125 rows"   fine
//   "... CELEBRITY MILLENNIUM 2026 ORDERING SCHEDULE-HOTEL BIWEEKLY
//        HOTEL.xlsx -> Millennium (via filename): 0 DG3 orders"        unreadable
//   "... UPDATED _ Xcel Ordering Schedule.xls: schedule - could not map
//        to a known ship, skipped"                                      unmatched
//   "no spreadsheet attachment; 1 attachments: Updated Ordering
//        Schedule CEL Ascent.png:image/png"                             image
// Azamara ships have no ordering schedule of their own - their dates come from
// Ray's monthly MLS - so they are never asked for one here.

import { parseFleetMap, normShip } from './fleet.js';
import { isAzamara, inService } from './fleetStatus.js';

export const STATUS = {
  OK: 'ok',                 // eligible rows with a due date still ahead
  STALE: 'stale',           // rows loaded, every due date already passed
  NEVER: 'never',           // nothing loaded, no attempt on record
  NOFILE: 'nofile',         // a mail arrived with no spreadsheet in it
  IMAGE: 'image',           // a picture of the schedule, not the file
  UNREADABLE: 'unreadable', // the file was read and yielded no DG3 orders
  UNMATCHED: 'unmatched',   // the file could not be tied to a ship
  WRONGTYPE: 'wrongtype',   // a PDF or other non-spreadsheet file
};

// What went wrong with one ingest-log line, or null if it read fine.
export function classifyNote(note) {
  const n = String(note || '');
  if (/could not map to a known ship/i.test(n)) return STATUS.UNMATCHED;
  if (/\b0 DG3 orders\b/.test(n)) return STATUS.UNREADABLE;
  if (/no spreadsheet attachment/i.test(n)) {
    if (/\b0 attachments\b/.test(n)) return STATUS.NOFILE;
    if (/image\//i.test(n)) return STATUS.IMAGE;
    return STATUS.WRONGTYPE; // a PDF, a Word file, a CSV: a file, but not the one
  }
  return null;
}

// The words the crew read, one short line per state. The "send it to" line is
// added by the renderer, once, so it is the same on every email.
export const CREW_LINE = {
  [STATUS.NEVER]: 'We do not have your ship\'s Ordering Schedule. It is the Excel file from your Inventory Manager, the one with HOTEL BIWEEKLY HOTEL in it.',
  [STATUS.NOFILE]: 'You sent us an email with no file in it. We need the Ordering Schedule Excel file.',
  [STATUS.IMAGE]: 'You sent us a picture of the Ordering Schedule. We need the Excel file, not a picture.',
  [STATUS.UNREADABLE]: 'We got your Ordering Schedule file but we could not read it. Please send the original Excel file from your Inventory Manager, not a copy or a PDF.',
  [STATUS.UNMATCHED]: 'We got an Ordering Schedule file but it does not say which ship it is for.',
  [STATUS.WRONGTYPE]: 'You sent us a PDF or another kind of file. We need the Excel file itself.',
  [STATUS.STALE]: 'Your Ordering Schedule has ended. We need the new one.',
};

// "... Beyond Ordering Schedule.xls → Beyond (via filename): ..." -> 'beyond'.
export function mappedShip(note) {
  const m = /→\s*([^(:→]+?)\s*\(via\b/.exec(String(note || ''));
  return m ? normShip(m[1]) : null;
}

// Pure: ships [{ship, address}], schedule [{ship, upcoming, last_due}],
// attempts [{sender, ts, note}] newest first.
export function judgeShips({ ships, schedule, attempts, today }) {
  const sched = new Map(schedule.map((r) => [normShip(r.ship), r]));
  const out = [];
  for (const s of ships) {
    if (isAzamara(s.ship) || !inService(s.ship, today)) continue;
    const key = normShip(s.ship);
    const row = sched.get(key);
    const addr = String(s.address || '').toLowerCase();
    const nameRe = new RegExp(`\\b${s.ship.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    // A line cims-hon MAPPED to a ship ("... -> Beyond (via filename)") belongs
    // to that ship only, whoever sent it: Ascent forwarding Beyond's file is
    // Beyond's attempt, not Ascent's. Otherwise by sender, then by the ship's
    // name in the line: Millennium's printer writes from celebritycruises.com
    // while FLEET_MAP carries celebrity.com.
    const mine = attempts.filter((a) => {
      const n = String(a.note || '');
      const to = mappedShip(n);
      if (to) return to === key;
      return (addr && String(a.sender || '').toLowerCase() === addr) || nameRe.test(n);
    });
    const last = mine[0] || null;
    let status;
    let detail;
    if (row && Number(row.upcoming) > 0) {
      status = STATUS.OK;
      detail = `${row.upcoming} due dates ahead, last ${row.last_due}`;
    } else if (last && classifyNote(last.note)) {
      status = classifyNote(last.note);
      detail = `last attempt ${String(last.ts).slice(0, 10)}: ${String(last.note).slice(0, 160)}`;
    } else if (row) {
      status = STATUS.STALE;
      detail = `schedule loaded but every due date has passed (last ${row.last_due})`;
    } else {
      status = STATUS.NEVER;
      detail = last ? `last mail ${String(last.ts).slice(0, 10)} wrote no rows` : 'no schedule and no attempt on record';
    }
    out.push({ ship: s.ship, status, detail, last_due: row ? row.last_due : null,
      last_attempt: last ? String(last.ts).slice(0, 10) : null });
  }
  return out;
}

export const needsSchedule = (statuses) => (statuses || []).filter((s) => s.status !== STATUS.OK);

const ELIGIBLE = `(
     UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
  OR UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
  OR mot = 'AZAMARA BWS')`;

// The fleet is FLEET_MAP: the ships a human said we can write to. A ship that
// is not in it cannot be told anything, so it is not judged here either; the
// unaddressable list in /fleet already names it.
export async function scheduleStatuses(hon, fleetMapText, today) {
  const { map } = parseFleetMap(fleetMapText);
  const ships = [...map.values()].map((v) => ({ ship: v.ship, address: v.to[0] }));
  if (!ships.length) return { ran: false, reason: 'FLEET_MAP is empty', statuses: [] };
  try {
    const schedule = (await hon.prepare(
      `SELECT ship,
              SUM(CASE WHEN due_date >= ?1 AND ${ELIGIBLE} THEN 1 ELSE 0 END) upcoming,
              MAX(CASE WHEN ${ELIGIBLE} THEN due_date END) last_due
         FROM schedule_order GROUP BY ship`).bind(today).all()).results || [];
    // cims-hon's lines about schedule files, newest first: source = 'email' is
    // cims-hon's ingest. THIS WORKER'S OWN LINES ARE EXCLUDED ON PURPOSE - its
    // chase-send line names every chased ship and says "schedule", and on
    // 17 Sep 2026 it re-judged all six chased ships as "never sent" (found by
    // the code review that night). A no-attachment line does not say
    // "schedule" at all, so it is selected by its own prefix.
    const attempts = (await hon.prepare(
      `SELECT sender, ts, note FROM ingest_log
        WHERE source IN ('email', 'reingest')
          AND (lower(note) LIKE '%schedule%' OR note LIKE 'no spreadsheet attachment%')
          AND note NOT LIKE 'not an Azamara MLS%'
          AND ts >= date(?1, '-120 day')
        ORDER BY ts DESC LIMIT 400`).bind(today).all()).results || [];
    return { ran: true, reason: null, statuses: judgeShips({ ships, schedule, attempts, today }) };
  } catch (e) {
    return { ran: false, reason: String((e && e.message) || e), statuses: [] };
  }
}
