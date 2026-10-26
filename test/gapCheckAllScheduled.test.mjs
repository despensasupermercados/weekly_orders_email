// node test/gapCheckAllScheduled.test.mjs
//
// A FLEET WHERE EVERY SHIP HAS A SCHEDULE IS NOT A CHECK THAT DID NOT RUN.
// 26 Oct 2026, after schedules for Solstice (20 Oct), Infinity and Ascent
// (21 Oct) were loaded: all 48 ships in the in-transit feed had a usable
// ordering schedule, so the schedule-free check had no ship to cover. It said
// "did not run", and the fleet email printed COULD NOT CHECK over a run that
// examined 48 of 48 ships. An empty feed is still a check that did not run.
// Runs the REAL query in src/lib/fallback.js against SQLite.

import assert from 'node:assert';
process.emitWarning = () => {};
const { DatabaseSync } = await import('node:sqlite');
const { DDL } = await import('../src/lib/obpCsv.js');
const { unscheduledGaps } = await import('../src/lib/fallback.js');
const { fleetCoverage } = await import('../src/lib/coverage.js');

const TODAY = '2026-10-26';

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE schedule_order (id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT, voyage TEXT, mot TEXT, loading_port TEXT, loading_delivery_date TEXT, due_date TEXT, source TEXT, po_number TEXT, po_state TEXT, date_changed INTEGER);
    CREATE TABLE obp_intransit (ship TEXT, part_number TEXT, eta TEXT, qty REAL, snapshot_date TEXT);`);
  for (const sql of DDL) db.exec(sql);
  const hon = {
    prepare(sql) {
      let args = [];
      const st = {
        bind(...a) { args = a; return st; },
        async all() { return { results: db.prepare(sql).all(...args) }; },
        async first() { return db.prepare(sql).get(...args) ?? null; },
        async run() { const r = db.prepare(sql).run(...args); return { meta: { changes: r.changes } }; },
      };
      return st;
    },
  };
  const landing = (ship, eta, snapshot = TODAY) => db.prepare(
    "INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES (?, 'A3VX330', 6, ?, ?, 'csv')").run(ship, eta, snapshot);
  const schedule = (ship, due) => db.prepare(
    "INSERT INTO schedule_order (ship, voyage, mot, loading_delivery_date, due_date, source) VALUES (?, 'V1', 'HOTEL - BIWEEKLY HOTEL', '2026-12-01', ?, 'test')").run(ship, due);
  return { db, hon, landing, schedule };
}

// 1. Every ship in the feed has a usable schedule: the check ran, and there
// was nothing for it to cover.
{
  const { hon, landing, schedule } = fresh();
  for (const sh of ['Solstice', 'Navigator']) {
    schedule(sh, '2026-11-30');
    landing(sh, '2026-11-10'); landing(sh, '2026-12-08'); landing(sh, '2027-01-05');
  }
  const g = await unscheduledGaps(hon, TODAY);
  assert.equal(g.ran, true, `every ship scheduled is a check that ran: ${g.reason}`);
  assert.equal(g.allScheduled, true);
  assert.equal(g.ships, 0);
  assert.deepEqual(g.findings, []);
  assert.deepEqual(g.deliveries, []);
  assert.deepEqual(g.shipNames, []);

  // And the coverage block reads it as clean, as the 26 Oct run should have.
  const c = fleetCoverage({ fleetMap: '', today: TODAY, checked: ['Solstice', 'Navigator'], checks: [{ name: 'voyage', ran: true }, { name: 'delivery gap', ran: g.ran, reason: g.reason }] });
  assert.equal(c.broken.length, 0, 'no broken check');
}

// 2. The feed is empty: nothing was looked at. That is still "did not run".
{
  const { hon, schedule } = fresh();
  schedule('Solstice', '2026-11-30');
  const g = await unscheduledGaps(hon, TODAY);
  assert.equal(g.ran, false, 'an empty feed is a check that did not run');
  assert.match(g.reason, /no row with a landing date/);
  assert.ok(!/\.$/.test(g.reason), 'the reason carries no full stop of its own');
}

// 3. The latest snapshot has rows but none with a landing date: the same as
// empty. An older snapshot with dates does not rescue it.
{
  const { hon, db, landing, schedule } = fresh();
  schedule('Solstice', '2026-11-30');
  landing('Solstice', '2026-11-10', '2026-10-19');
  db.prepare("INSERT INTO weekly_obp_intransit (ship, part_number, qty, eta_date, snapshot_date, source) VALUES ('Solstice', 'A3VX330', 6, NULL, ?, 'csv')").run(TODAY);
  const g = await unscheduledGaps(hon, TODAY);
  assert.equal(g.ran, false, 'a latest snapshot with no landing date is an empty feed');
}

// 4. A ship whose schedule has ended is no better off than one that never sent
// one: it is still covered by this check, so the fleet is NOT all scheduled.
{
  const { hon, landing, schedule } = fresh();
  schedule('Solstice', '2026-11-30');
  schedule('Beyond', '2026-10-01'); // ended
  landing('Solstice', '2026-11-10');
  for (const eta of ['2026-11-02', '2026-11-30', '2026-12-28', '2027-03-15']) landing('Beyond', eta);
  const g = await unscheduledGaps(hon, TODAY);
  assert.equal(g.ran, true);
  assert.ok(!g.allScheduled, 'an ended schedule leaves the ship to this check');
  assert.deepEqual(g.shipNames, ['Beyond']);
  assert.equal(g.findings.length, 1, 'Beyond\'s 77-day gap is found');
}

// 5. A reason that ends in a full stop prints one full stop, not two.
{
  const c = fleetCoverage({ fleetMap: '', today: TODAY, checked: ['Solstice'], checks: [{ name: 'runway', ran: false, reason: 'no snapshot for today.' }] });
  assert.ok(c.lines[0].includes('no snapshot for today. Every ship'), c.lines[0]);
  assert.ok(!c.lines[0].includes('..'), c.lines[0]);
}

console.log('ok - gap check: a fully scheduled fleet is clean, an empty feed is not, an ended schedule still counts as none');
