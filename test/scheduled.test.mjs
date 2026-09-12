// node test/scheduled.test.mjs
//
// WHY THIS FILE EXISTS. Every part of the Monday email had a passing unit test
// while the handler that assembles and sends it had none. So this shipped:
//
//     const { rows, act, html } = await buildWeekly(env, today);
//     ...
//     if (!act.length && !gaps.length && !runsOut.length) return;
//
// `gaps` and `runsOut` were never bound in that scope. Under ESM that is a
// ReferenceError on every single run, thrown before one address was resolved -
// and from the outside it is indistinguishable from the cron not firing, which
// is a failure this Worker has already had twice. Thirteen green test files and
// the email could not send at all.
//
// The lesson is not "add a test for that line". It is that the seam between
// tested pieces is where this project keeps breaking, so the seam gets run.

import worker from '../src/index.js';
import assert from 'node:assert';

const TODAY = '2026-09-14'; // a Monday

// Two eligible voyages: one with an order, one without. The one without is the
// only actionable row, so act.length is small on purpose - the point is that
// the run must still carry the findings that do NOT come from voyage rows.
const VOYAGES = [
  { ship: 'Quest', mot: 'AZAMARA BWS', loading_delivery_date: '2026-10-14',
    due_date: '2026-09-16', order_lines: 4, po_state: 'recorded', port: 'Miami' },
  { ship: 'Anthem', mot: 'Hotel Bi-Weekly Hotel', loading_delivery_date: '2026-10-20',
    due_date: '2026-09-17', order_lines: 0, po_state: 'none', port: 'Miami' },
];

const COLUMNS = {
  consumption_snapshot: ['ship', 'part_number', 'month', 'on_hand', 'receipts'],
  obp_inventory: ['ship', 'part_number', 'on_hand', 'snapshot_date'],
  obp_intransit: ['ship', 'part_number', 'eta', 'qty', 'snapshot_date'],
  par: ['ship', 'part_number', 'description'],
};

// One delivery series with a hole in it, on a ship with no ordering schedule.
const DELIVERIES = [
  { ship: 'Explorer', date: '2026-09-20' },
  { ship: 'Explorer', date: '2026-10-18' },
  { ship: 'Explorer', date: '2026-11-15' },
  { ship: 'Explorer', date: '2027-01-20' }, // a 66-day gap against a 28-day rhythm
];

// One item that empties before the container that would refill it.
const RATES = [
  { ship: 'Quest', item: 'TN619M MAGENTA TONER', rate: 14, on_hand: 3,
    next_eta: '2026-11-30', in_transit: 10 },
];

const logged = [];
const sent = [];

const fakeDb = {
  prepare(sql) {
    const stmt = {
      bind: () => stmt,
      run: async () => {
        if (/INSERT INTO ingest_log/.test(sql)) logged.push(sql);
        return { success: true };
      },
      first: async () => ({}),
      all: async () => {
        const m = /PRAGMA table_info\((\w+)\)/.exec(sql);
        if (m) return { results: (COLUMNS[m[1]] || []).map((name) => ({ name })) };
        if (/FROM schedule_order/.test(sql) && /obp_intransit/.test(sql)) return { results: DELIVERIES };
        if (/consumption_snapshot/.test(sql)) return { results: RATES };
        if (/loading_delivery_date/.test(sql) || /schedule_order/.test(sql)) return { results: VOYAGES };
        return { results: [] };
      },
    };
    return stmt;
  },
};

const env = {
  HON: fakeDb,
  DRY_RUN_TO: 'ops@example.com',
  MAILER: {
    // The real call is env.MAILER.fetch(url, init) on a service binding, not
    // fetch(Request). Mirror that shape or the mock proves nothing.
    fetch: async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200 });
    },
  },
};

const waits = [];
const ctx = { waitUntil: (p) => waits.push(p) };

// THE TEST. If the handler throws, this line fails - which is all the blocker
// above ever needed.
await worker.scheduled({ cron: '0 12 * * MON', scheduledTime: Date.parse(TODAY) }, env, ctx);
await Promise.all(waits);

assert.equal(sent.length, 1, 'the dry run must send exactly one fleet email');
const mail = sent[0];

// THE SUBJECT MUST COUNT EVERYTHING THE EMAIL CARRIES. It counted actionable
// voyages alone, so a week holding 39 stockouts went out as "0 to fix".
assert.ok(/\d+ to fix/.test(mail.subject), `subject names a count: ${mail.subject}`);
assert.ok(!/ 0 to fix/.test(mail.subject),
  `subject must not say 0 while the body carries findings: ${mail.subject}`);

// THE PREHEADER IS THE INBOX LINE. Same bug, more visible.
assert.ok(!/^0 orders/.test(mail.html) && !/>0 order/.test(mail.html),
  'the preheader must not announce zero when there are findings');
assert.ok(/to do this week/.test(mail.html), 'the preheader states the real total');

// The two schedule-free halves of the email must actually be in it.
assert.ok(/Explorer/.test(mail.html), 'a delivery gap reaches the fleet email');
assert.ok(/MAGENTA/.test(mail.html), 'a stockout reaches the fleet email');

console.log('ok - the Monday run assembles and sends: no unbound binding, and the subject');
console.log('     and preheader count the stockouts and gaps, not just the voyage rows');
