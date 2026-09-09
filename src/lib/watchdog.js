// The night agent.
//
// Runs every night. Its job is to notice the things that break quietly, repair
// what is safe to repair, and stay silent when there is nothing to say. Every
// check here exists because that exact failure already happened once.
//
// DESIGN RULES
//  1. Repairs are only ever DELETES of rows that should not exist. It never
//     invents data, never rewrites a value, never touches obp_* tables - those
//     are a mirror of Ray's export and must stay byte-faithful.
//  2. Anything it cannot repair it reports. Anything it repairs it also reports.
//  3. Silence means healthy. A nightly mail that always arrives gets filtered.
//  4. Every finding names the number AND the population. A bare count is how
//     this project produced three confident wrong answers in one week.

// NORMALISE BY REMOVING HYPHENS *AND* SPACES. Symphony's schedule carries
// "HOTEL BIWEEKLY - HOTEL"; replacing the hyphen with a space leaves a double
// space and the LIKE fails. With the old expression this watchdog would have
// classified all 10 of Symphony's real voyages as out-of-scope and DELETED THEM.
export const ELIGIBLE_MOT_SQL = `(
     UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELBIWEEKLYHOTEL%'
  OR UPPER(REPLACE(REPLACE(mot,'-',''),' ','')) LIKE 'HOTELMONTHLY%'
  OR mot = 'AZAMARA BWS')`;

// Rows this Worker wrote and may therefore delete. Anything else in
// schedule_order was put there by cims-hon's own ingest and is NOT ours to
// repair - the standing guardrail is that each app manages its own rows. We
// report those and leave them alone.
export const OWNED_SOURCES = "('azamara-mls', 'ordering-schedule')";

const one = async (db, sql, ...b) => (await db.prepare(sql).bind(...b).first()) || {};
const many = async (db, sql, ...b) => ((await db.prepare(sql).bind(...b).all()).results || []);

export async function runWatchdog(env, today, { repair = true } = {}) {
  const hon = env.HON;
  const findings = [];
  const repairs = [];
  const add = (severity, check, detail) => findings.push({ severity, check, detail });

  // ---- 1. Is the OBP feed still arriving? ----
  // Every number this system prints is a statement about stale data if this
  // stops and nobody notices.
  const snap = await one(hon,
    `SELECT MAX(snapshot_date) inv, (SELECT MAX(snapshot_date) FROM obp_intransit) it FROM obp_inventory`);
  for (const [name, d] of [['obp_inventory', snap.inv], ['obp_intransit', snap.it]]) {
    const age = d ? Math.round((Date.parse(today) - Date.parse(d)) / 86400000) : null;
    if (age === null) add('critical', 'feed', `${name} has no snapshot at all`);
    else if (age >= 2) add(age >= 4 ? 'critical' : 'warn', 'feed',
      `${name} last snapshot ${d}, ${age} days old`);
  }

  // ---- 2. ETA format drift ----
  // obp_intransit.eta is an Excel serial in a TEXT column. If Ray's export ever
  // switches to real dates, every date comparison silently matches nothing and
  // the weekly email goes quiet while ships miss containers.
  const eta = await one(hon,
    `SELECT COUNT(*) n, SUM(CASE WHEN eta GLOB '[0-9]*' THEN 0 ELSE 1 END) bad
       FROM obp_intransit WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)`);
  if (eta.n && eta.bad) add('critical', 'eta_format',
    `${eta.bad} of ${eta.n} in-transit rows have a non-numeric eta - the export format may have changed`);

  // ---- 3. Scope boundary: only our supply stream may be stored ----
  // Ray, 9 Sep 2026: the other MOTs belong to other departments and are not
  // ours to touch or even look at.
  const strays = await many(hon,
    `SELECT mot, source, COUNT(*) n FROM schedule_order
      WHERE NOT ${ELIGIBLE_MOT_SQL} GROUP BY mot, source`);
  const ours = strays.filter((r) => ['azamara-mls', 'ordering-schedule'].includes(r.source));
  const theirs = strays.filter((r) => !['azamara-mls', 'ordering-schedule'].includes(r.source));
  if (ours.length) {
    const total = ours.reduce((s, r) => s + r.n, 0);
    if (repair) {
      await hon.prepare(
        `DELETE FROM schedule_order WHERE NOT ${ELIGIBLE_MOT_SQL} AND source IN ${OWNED_SOURCES}`
      ).run();
      repairs.push(`removed ${total} out-of-scope rows we wrote (${ours.map((r) => r.mot).join(', ')})`);
    } else {
      add('warn', 'scope', `${total} out-of-scope rows from our own ingest: ${ours.map((r) => `${r.mot} x${r.n}`).join(', ')}`);
    }
  }
  // NEVER auto-delete another app's rows. cims-hon's schedule ingest owns them,
  // and a watchdog that quietly deletes a neighbour's data is worse than the
  // problem it is solving.
  for (const t of theirs) {
    add('warn', 'scope',
      `${t.n} rows with MOT "${t.mot}" from source "${t.source}" are outside our stream - NOT touched, ${t.source} owns them`);
  }

  // ---- 4. Orphaned Azamara swap rows ----
  // saveAzamara parks the previous publication as 'azamara-mls:prev' and deletes
  // it after the insert. If that run dies between the two, the parked set stays
  // and every Azamara voyage appears twice.
  const orphan = await one(hon,
    `SELECT COUNT(*) n FROM schedule_order WHERE source = 'azamara-mls:prev'`);
  if (orphan.n) {
    if (repair) {
      await hon.prepare(`DELETE FROM schedule_order WHERE source = 'azamara-mls:prev'`).run();
      repairs.push(`cleared ${orphan.n} orphaned azamara-mls:prev rows from a failed swap`);
    } else add('warn', 'orphan_rows', `${orphan.n} azamara-mls:prev rows left behind`);
  }

  // ---- 5. Duplicate voyages ----
  // A re-ingest without a clean delete doubles rows, which doubles a ship in the
  // weekly email and destroys its credibility faster than a missed order.
  const dupes = await many(hon,
    `SELECT ship, voyage, mot, due_date, COUNT(*) n FROM schedule_order
      WHERE ${ELIGIBLE_MOT_SQL}
      GROUP BY ship, voyage, mot, due_date HAVING COUNT(*) > 1`);
  if (dupes.length) {
    if (repair) {
      await hon.prepare(
        `DELETE FROM schedule_order WHERE id NOT IN (
           SELECT MIN(id) FROM schedule_order GROUP BY ship, voyage, mot, due_date)`
      ).run();
      repairs.push(`de-duplicated ${dupes.length} voyage rows`);
    } else add('warn', 'duplicates', `${dupes.length} duplicated (ship, voyage, mot, due_date) rows`);
  }

  // ---- 6. Schedule coverage and staleness ----
  // A ship whose schedule runs out stops being checkable and says nothing about
  // it. Silence is exactly how an order gets forgotten.
  const cover = await many(hon,
    `SELECT ship, MAX(loading_delivery_date) last_load, COUNT(*) rows_
       FROM schedule_order WHERE ${ELIGIBLE_MOT_SQL} GROUP BY ship`);
  const fleet = await one(hon, `SELECT COUNT(DISTINCT ship) n FROM par`);
  const covered = cover.length;
  if (fleet.n && covered < fleet.n) {
    add('warn', 'coverage',
      `${covered} of ${fleet.n} ships have an ordering schedule loaded - the rest cannot be checked at all`);
  }
  for (const c of cover) {
    const daysLeft = Math.round((Date.parse(c.last_load) - Date.parse(today)) / 86400000);
    if (daysLeft < 0) add('critical', 'schedule_expired',
      `${c.ship} schedule ended ${c.last_load} - it is invisible to the weekly check`);
    else if (daysLeft < 30) add('warn', 'schedule_expiring',
      `${c.ship} schedule runs out in ${daysLeft} days (${c.last_load}) - ask Ray for the next one`);
  }

  // ---- 7. Did the weekly email actually send? ----
  const lastSend = await one(hon,
    `SELECT MAX(ts) ts FROM ingest_log WHERE sender = 'cron' AND note LIKE '%send%'`);
  const fails = await many(hon,
    `SELECT ts, note FROM ingest_log
      WHERE sender = 'cron' AND note LIKE '%FAILED%' AND ts >= datetime(?, '-8 day')
      ORDER BY ts DESC LIMIT 5`, today);
  for (const f of fails) add('critical', 'send_failed', `${f.ts}: ${f.note}`);

  // ---- 8. Ingest refusals ----
  // The Azamara handler refuses partial writes rather than corrupting the table.
  // A refusal is correct behaviour AND a thing a human must look at.
  const refused = await many(hon,
    `SELECT ts, note FROM ingest_log
      WHERE note LIKE 'Azamara MLS REFUSED%' AND ts >= datetime(?, '-8 day')
      ORDER BY ts DESC LIMIT 5`, today);
  for (const r of refused) add('critical', 'ingest_refused', `${r.ts}: ${r.note}`);

  return {
    today,
    healthy: findings.length === 0 && repairs.length === 0,
    repairs,
    findings,
    counts: {
      critical: findings.filter((f) => f.severity === 'critical').length,
      warn: findings.filter((f) => f.severity === 'warn').length,
      ships_covered: covered,
      fleet: fleet.n || null,
      last_send: lastSend.ts || null,
    },
  };
}
