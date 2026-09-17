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
  schedule_order: ['ship', 'mot', 'due_date', 'loading_delivery_date'],
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
    next_eta: '2026-11-30', on_next: 10, order_due: null, order_lands: null, has_schedule: 0 },
];

// What the schedule-status check reads: Anthem has a schedule with due dates
// ahead, Quest is Azamara (never asked), Explorer has no schedule at all and
// nothing in the ingest log - so Explorer is asked for its file.
const SCHED = [
  { ship: 'Anthem', upcoming: 5, last_due: '2026-11-30' },
  { ship: 'Quest', upcoming: 1, last_due: '2026-12-08' },
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
        // The schedule-status check, before the generic schedule_order routes.
        if (/END\) upcoming/.test(sql)) return { results: SCHED };
        if (/lower\(note\) LIKE/.test(sql)) return { results: [] };
        // The runway query reads all four tables; route it before the others.
        if (/consumption_snapshot/.test(sql)) return { results: RATES };
        if (/FROM schedule_order/.test(sql) && /obp_intransit/.test(sql)) return { results: DELIVERIES };
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

// LIVE. Miguel, 15 Sep 2026: the whole-fleet list to onboardsupport, one email
// per ship to that ship's mailbox with Ray in copy. The same run, switched on.
{
  sent.length = 0; waits.length = 0;
  const live = {
    ...env,
    SEND_TO_FLEET: 'true',
    FLEET_TO: 'onboardsupport@example.com',
    SHIP_CC: 'ray@example.com',
    REPLY_TO: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com\nAnthem = an_printerspecialist@example.com',
  };
  await worker.scheduled({ cron: '0 12 * * MON', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  const ships = sent.filter((m) => /^[A-Z][a-z]+: /.test(m.subject));
  const digest = sent.filter((m) => /^Orders due this week/.test(m.subject));
  assert.ok(ships.length >= 2, `one email per ship with a finding, got ${ships.length}`);
  for (const m of ships) {
    assert.deepEqual(m.cc, ['ray@example.com'], `${m.subject}: Ray is in copy`);
    assert.equal(m.to.length, 1, `${m.subject}: to the ship only`);
    assert.ok(!m.to.includes('onboardsupport@example.com'), `${m.subject}: onboardsupport is not a ship`);
  }
  const quest = ships.find((m) => m.subject.startsWith('Quest:'));
  assert.ok(quest, 'Quest, a stockout-only ship, is mailed');
  assert.deepEqual(quest.to, ['qs_pm@example.com']);
  // REPLY-TO IS RAY. The mail is from cims@cims.work, which nobody reads.
  for (const m of ships) assert.equal(m.replyTo, 'ray@example.com', `${m.subject}: replies go to Ray`);
  // SEND YOUR ORDERING SCHEDULE FIRST. Explorer has no schedule loaded and
  // no file on record, so its email opens with the ask; Anthem has one and
  // is not nagged; Quest is Azamara and is never asked.
  const explorer = ships.find((m) => m.subject.startsWith('Explorer:'));
  assert.ok(explorer, 'Explorer is mailed');
  assert.ok(/send your Ordering Schedule/.test(explorer.subject), `Explorer's subject asks for the file: ${explorer.subject}`);
  assert.ok(/DO THIS FIRST/.test(explorer.html) && /obp@cims.work/.test(explorer.html), 'Explorer is told what to send and where');
  assert.ok(!/DO THIS FIRST/.test(quest.html), 'an Azamara ship is never asked for an ordering schedule');
  // Anthem has a schedule with dates ahead: whatever else it is mailed, it is
  // not asked for the file. Only Explorer carries the ask.
  assert.ok(!ships.some((m) => !m.subject.startsWith('Explorer:') && /DO THIS FIRST/.test(m.html)),
    'a ship with a schedule is not asked for one');
  assert.equal(digest.length, 1, 'exactly one whole-fleet email');
  assert.deepEqual(digest[0].to, ['onboardsupport@example.com'], 'the fleet list goes to onboardsupport');
  assert.equal(digest[0].cc, undefined, 'and nobody is copied on it');
  assert.ok(!sent.some((m) => m.to.includes('ops@example.com')), 'DRY_RUN_TO is not used when live');
  console.log('ok - live: each ship gets its own email with Ray in copy, onboardsupport gets the fleet list');
}

// THE LIVE FLEET-LIST SUBJECT COUNTS EVERYTHING TOO. The dry run was fixed to
// count stockouts and gaps; the live path still read act.length alone, so a
// Monday with 0 voyages and 39 stockouts would have reached onboardsupport as
// "0 to fix". And ONE MAILER FAILURE MUST NOT ABORT THE LOOP: ship 12 failing
// used to mean ships 13-48 were never mailed.
{
  sent.length = 0; waits.length = 0;
  const live = {
    ...env,
    SEND_TO_FLEET: 'true',
    FLEET_TO: 'onboardsupport@example.com',
    SHIP_CC: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com',
    MAILER: {
      fetch: async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.to.includes('ex_printerspecialist@example.com')) throw new Error('transport reset');
        sent.push(body);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    },
  };
  await worker.scheduled({ cron: '0 12 * * MON', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  const digest = sent.find((m) => /^Orders due this week/.test(m.subject));
  assert.ok(digest, 'the fleet list still goes out after a ship send threw');
  assert.ok(!/ 0 to fix/.test(digest.subject), `live subject must count stockouts and gaps: ${digest.subject}`);
  // One stockout (Quest), one gap (Explorer) and one ship asked for its
  // schedule (Explorer again) = 3.
  assert.ok(/ 3 to fix/.test(digest.subject), `one stockout + one gap + one schedule ask = 3: ${digest.subject}`);
  assert.ok(sent.some((m) => m.subject.startsWith('Quest:')), 'Quest was still mailed after Explorer threw');
  assert.ok(/1 of 2 ships mailed/.test(digest.subject), `the digest reports the failed ship: ${digest.subject}`);
  console.log('ok - live: one transport failure does not abort the loop, and the fleet-list subject counts everything');
}

// THE NIGHTLY CRON STRING IN CODE EQUALS THE ONE IN wrangler.toml. They drifted
// once and the weekly path ran every night.
{
  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const nightly = /const NIGHTLY_CRON = '([^']+)'/.exec(src)[1];
  assert.ok(crons.includes(nightly), `NIGHTLY_CRON ${nightly} is not one of wrangler's crons ${crons}`);
  assert.ok(crons.includes('0 12 * * MON'), 'the weekly cron is Monday 12:00 UTC');
  console.log('ok - crons: NIGHTLY_CRON matches wrangler.toml character for character');
}

// THE ON-DEMAND SEND QUEUE. Miguel, 16 Sep 2026: "trigger the workflow and
// pick one ship for testing." Nothing outside can reach this Worker's HTTP
// surface, so a row in weekly_send_request is the trigger: the 15-minute cron
// sends that ship's email, to its FLEET_MAP mailbox when no address is given,
// with Ray copied as on a Monday plus the row's own cc, and marks the row done.
// The Monday fleet path must NOT run on that cron, or on any cron but its own.
{
  sent.length = 0; waits.length = 0; logged.length = 0;
  const queue = [{ id: 7, ship: 'Explorer', to_json: null, cc_json: '["miguel@example.com"]', note: 'test send' }];
  const updates = [];
  const queued = {
    prepare(sql) {
      const inner = fakeDb.prepare(sql);
      const stmt = {
        bind: (...a) => { stmt._binds = a; return stmt; },
        run: async () => {
          if (/result = 'claimed'/.test(sql)) { const row = queue.find((q) => q.id === stmt._binds[0]); const ok = Boolean(row && !row.claimed); if (ok) row.claimed = true; return { success: true, meta: { changes: ok ? 1 : 0 } }; }
          if (/UPDATE weekly_send_request/.test(sql)) { updates.push(stmt._binds); queue.length = 0; }
          return inner.run();
        },
        first: inner.first,
        all: async () => (/FROM weekly_send_request/.test(sql) ? { results: queue.slice() } : inner.all()),
      };
      return stmt;
    },
  };
  const live = {
    ...env, HON: queued,
    SEND_TO_FLEET: 'true', FLEET_TO: 'onboardsupport@example.com', SHIP_CC: 'ray@example.com', REPLY_TO: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com\nAnthem = an_printerspecialist@example.com',
  };
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  assert.equal(sent.length, 1, `the request cron sends exactly the queued ship, got ${sent.map((m) => m.subject)}`);
  assert.ok(sent[0].subject.startsWith('Explorer:'), sent[0].subject);
  assert.deepEqual(sent[0].to, ['ex_printerspecialist@example.com'], 'no address given: the FLEET_MAP mailbox');
  assert.deepEqual(sent[0].cc.sort(), ['miguel@example.com', 'ray@example.com'], 'Ray as on a Monday, plus the row\'s cc');
  assert.equal(sent[0].replyTo, 'ray@example.com');
  assert.ok(/DO THIS FIRST/.test(sent[0].html), 'the email is the real one Explorer would get');
  assert.equal(updates.length, 1, 'the row is marked done');
  assert.equal(updates[0][0], 7);
  assert.ok(/"sent":true/.test(updates[0][1]), `the result is recorded: ${updates[0][1]}`);
  assert.ok(!sent.some((m) => /^Orders due this week/.test(m.subject)), 'the fleet list is NOT sent by the request cron');

  // No row pending: one SELECT, nothing sent.
  sent.length = 0;
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, live, ctx);
  assert.equal(sent.length, 0, 'an empty queue sends nothing');

  // A cron nobody wired must not fall through to the Monday fleet path.
  sent.length = 0; waits.length = 0;
  await worker.scheduled({ cron: '0 9 * * *', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  assert.equal(sent.length, 0, 'an unhandled cron mails nobody');
  assert.ok(logged.length, 'and is logged');

  const { readFileSync } = await import('node:fs');
  const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const crons = /crons\s*=\s*\[([^\]]*)\]/.exec(toml)[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.ok(crons.includes(/const REQUEST_CRON = '([^']+)'/.exec(src)[1]), 'REQUEST_CRON is in wrangler.toml');
  assert.ok(crons.includes(/const WEEKLY_CRON = '([^']+)'/.exec(src)[1]), 'WEEKLY_CRON is in wrangler.toml');
  assert.ok(crons.includes(/const MONTHLY_CHASE_CRON = '([^']+)'/.exec(src)[1]), 'MONTHLY_CHASE_CRON is in wrangler.toml');
  assert.equal(/const MONTHLY_CHASE_CRON = '([^']+)'/.exec(src)[1].split(' ')[2], '2', 'the monthly chase is the 2nd of the month');
  console.log('ok - on-demand queue: a row sends one ship\'s real email and is marked done; other crons never mail the fleet');
}

// THE SCHEDULE CHASE. Miguel, 17 Sep 2026: "1 per ship and cc Ray. Always
// give them 24hr turnaround." A row with kind 'chase' and ship '*' sends one
// chase email to every ship missing its Ordering Schedule; a ship that has
// one is skipped, not mailed. Explorer has no schedule in the fixture, Anthem
// does, Quest is Azamara and is never asked.
{
  sent.length = 0; waits.length = 0; logged.length = 0;
  const queue = [
    { id: 8, ship: '*', to_json: null, cc_json: null, note: 'Ray asked', kind: 'chase' },
    { id: 9, ship: 'Anthem', to_json: null, cc_json: null, note: null, kind: 'chase' },
  ];
  const updates = [];
  const queued = {
    prepare(sql) {
      const inner = fakeDb.prepare(sql);
      const stmt = {
        bind: (...a) => { stmt._binds = a; return stmt; },
        run: async () => {
          if (/result = 'claimed'/.test(sql)) { const row = queue.find((q) => q.id === stmt._binds[0]); const ok = Boolean(row && !row.claimed); if (ok) row.claimed = true; return { success: true, meta: { changes: ok ? 1 : 0 } }; }
          if (/UPDATE weekly_send_request/.test(sql)) { updates.push(stmt._binds); queue.splice(queue.findIndex((q) => q.id === stmt._binds[0]), 1); }
          return inner.run();
        },
        first: inner.first,
        all: async () => (/FROM weekly_send_request/.test(sql) ? { results: queue.slice() } : inner.all()),
      };
      return stmt;
    },
  };
  const live = {
    ...env, HON: queued,
    SEND_TO_FLEET: 'true', FLEET_TO: 'onboardsupport@example.com', SHIP_CC: 'ray@example.com', REPLY_TO: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com\nAnthem = an_printerspecialist@example.com',
  };
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  assert.equal(sent.length, 1, `one chase per missing ship, got ${sent.map((m) => m.subject)}`);
  assert.equal(sent[0].subject, 'Explorer: send your Ordering Schedule file within 24 hours');
  assert.deepEqual(sent[0].to, ['ex_printerspecialist@example.com'], 'the ship\'s FLEET_MAP mailbox');
  assert.deepEqual(sent[0].cc, ['ray@example.com'], 'Ray in cc');
  assert.equal(sent[0].replyTo, 'ray@example.com', 'replies go to Ray');
  assert.equal(sent[0].templateId, 'ordering-schedule-chase');
  assert.ok(/EXPLORER &middot; WHY WE ARE WRITING/.test(sent[0].html), 'the chase email, not the weekly one');
  assert.ok(/within <b[^>]*>24 hours<\/b>/.test(sent[0].html), 'always 24 hours');
  assert.equal(updates.length, 2, 'both rows are marked done');
  const star = updates.find((u) => u[0] === 8)[1];
  assert.ok(/"count":1,"of":1/.test(star), `the '*' row records what it sent: ${star}`);
  const anthem = updates.find((u) => u[0] === 9)[1];
  assert.ok(/not missing its Ordering Schedule, not chased/.test(anthem), `a ship with a schedule is skipped: ${anthem}`);
  console.log('ok - schedule chase: ship * mails every missing ship once, cc Ray, 24 hours; a ship with a schedule is skipped');
}

// THE MONTHLY CHASE CRON. Miguel, 17 Sep 2026: "schedule this email on the 2nd
// day of each month and trigger all ships who are not in compliance." The cron
// queues the '*' chase row itself and runs the queue: Explorer (no schedule)
// is mailed, Anthem (has one) and Quest (Azamara) are not, and the fleet list
// is never sent by this cron.
{
  sent.length = 0; waits.length = 0; logged.length = 0;
  const queue = [];
  const inserts = [];
  const notes = [];
  const queued = {
    prepare(sql) {
      const inner = fakeDb.prepare(sql);
      const stmt = {
        bind: (...a) => { stmt._binds = a; return stmt; },
        run: async () => {
          if (/INSERT INTO ingest_log/.test(sql)) notes.push(String(stmt._binds[2]));
          if (/INSERT INTO weekly_send_request/.test(sql)) { inserts.push(stmt._binds); queue.push({ id: 10, ship: '*', kind: 'chase', to_json: null, cc_json: null, note: stmt._binds[0] }); }
          if (/result = 'claimed'/.test(sql)) { const row = queue.find((q) => q.id === stmt._binds[0]); const ok = Boolean(row && !row.claimed); if (ok) row.claimed = true; return { success: true, meta: { changes: ok ? 1 : 0 } }; }
          if (/UPDATE weekly_send_request/.test(sql)) queue.length = 0;
          return inner.run();
        },
        first: inner.first,
        all: async () => (/FROM weekly_send_request/.test(sql) ? { results: queue.slice() } : inner.all()),
      };
      return stmt;
    },
  };
  const live = {
    ...env, HON: queued,
    SEND_TO_FLEET: 'true', FLEET_TO: 'onboardsupport@example.com', SHIP_CC: 'ray@example.com', REPLY_TO: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com\nAnthem = an_printerspecialist@example.com',
  };
  await worker.scheduled({ cron: '0 13 2 * *', scheduledTime: Date.parse(TODAY) }, live, ctx);
  await Promise.all(waits);
  assert.equal(inserts.length, 1, 'the cron queues one * chase row');
  assert.equal(sent.length, 0, 'and sends nothing itself: the 15-minute runner does, so two ticks in one minute cannot double-send');
  assert.ok(notes.some((n) => /^monthly chase .*queued row/.test(n)), `the queueing is logged: ${notes.join(' || ')}`);
  // TWO 15-MINUTE TICKS IN THE SAME MINUTE (the production shape at 13:00 on
  // the 2nd): the atomic claim lets exactly one of them send.
  await Promise.all([
    worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, live, ctx),
    worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, live, ctx),
  ]);
  await Promise.all(waits);
  assert.equal(sent.length, 1, `one chase per missing ship even with two concurrent ticks, got ${sent.map((m) => m.subject)}`);
  assert.equal(sent[0].subject, 'Explorer: send your Ordering Schedule file within 24 hours');
  assert.deepEqual(sent[0].cc, ['ray@example.com'], 'Ray in cc');
  assert.ok(!sent.some((m) => /^Orders due this week/.test(m.subject)), 'the fleet list is NOT sent by the monthly chase');
  console.log('ok - monthly chase: the 2nd-of-month cron mails every ship out of compliance, one each, cc Ray, and nobody else');
}


// REVIEW OF 17 Sep 2026. (1) One ship's transport error must not end the
// chase for the ships after it. (2) If the schedule judgement did not run,
// the chase row is given back to the queue, not consumed as "nobody missing".
{
  sent.length = 0; waits.length = 0; logged.length = 0;
  const queue = [{ id: 20, ship: '*', to_json: null, cc_json: null, note: null, kind: 'chase' }];
  const updates = [];
  const mkQueued = (throwOnSchedule) => ({
    prepare(sql) {
      const inner = fakeDb.prepare(sql);
      const stmt = {
        bind: (...a) => { stmt._binds = a; return stmt; },
        run: async () => {
          if (/result = 'claimed'/.test(sql)) { const row = queue.find((q) => q.id === stmt._binds[0]); const ok = Boolean(row && !row.claimed); if (ok) row.claimed = true; return { success: true, meta: { changes: ok ? 1 : 0 } }; }
          if (/UPDATE weekly_send_request SET done_at = NULL/.test(sql)) { updates.push(['unclaim', ...stmt._binds]); const row = queue.find((q) => q.id === stmt._binds[0]); if (row) row.claimed = false; return { success: true }; }
          if (/UPDATE weekly_send_request/.test(sql)) { updates.push(['done', ...stmt._binds]); queue.length = 0; }
          return inner.run();
        },
        first: inner.first,
        all: async () => {
          if (throwOnSchedule && /END\) upcoming/.test(sql)) throw new Error('D1_ERROR: too many requests');
          return /FROM weekly_send_request/.test(sql) ? { results: queue.slice() } : inner.all();
        },
      };
      return stmt;
    },
  });
  const base = {
    ...env, SEND_TO_FLEET: 'true', FLEET_TO: 'onboardsupport@example.com', SHIP_CC: 'ray@example.com', REPLY_TO: 'ray@example.com',
    FLEET_MAP: 'Quest = qs_pm@example.com\nExplorer = ex_printerspecialist@example.com\nIcon = ic_printerspecialist@example.com\nAnthem = an_printerspecialist@example.com',
  };
  // (2) first: the judgement throws -> row un-claimed, nothing sent.
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, { ...base, HON: mkQueued(true) }, ctx);
  await Promise.all(waits);
  assert.equal(sent.length, 0, 'nothing chased when the judgement did not run');
  assert.ok(updates.some((u) => u[0] === 'unclaim' && u[1] === 20 && /schedule status check did not run/.test(u[2])), `row given back with the reason: ${JSON.stringify(updates)}`);
  assert.equal(queue.length, 1, 'and it is still pending');
  // (1) then: Explorer's send throws, Icon is still chased.
  updates.length = 0; waits.length = 0;
  const flaky = { ...base, HON: mkQueued(false), MAILER: { fetch: async (_u, init) => {
    const b = JSON.parse(init.body);
    if (/^Explorer:/.test(b.subject)) throw new Error('transport reset');
    sent.push(b); return new Response(JSON.stringify({ ok: true, id: 'x' }), { status: 200 });
  } } };
  await worker.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.parse(TODAY) }, flaky, ctx);
  await Promise.all(waits);
  assert.deepEqual(sent.map((m) => m.subject), ['Icon: send your Ordering Schedule file within 24 hours'], 'the ship after the failure is still mailed');
  assert.ok(sent[0].idempotencyKey && /^chase:20:icon$/.test(sent[0].idempotencyKey), `each send carries an idempotency key: ${sent[0].idempotencyKey}`);
  const done = updates.find((u) => u[0] === 'done');
  assert.ok(done && /"count":1,"of":2/.test(done[2]), `the row records 1 of 2: ${done && done[2]}`);
  assert.ok(logged.length, 'and the run is logged');
  console.log('ok - chase queue: one ship\'s transport error does not stop the rest; a failed judgement gives the row back');
}
