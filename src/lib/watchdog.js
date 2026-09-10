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

// ingest_log IS SHARED. cims-hon's own obp@cims.work route writes into the same
// table - on 10 Sep 2026 it held forty-odd mails from ships' printers, none of
// them ours. So "has any mail arrived?" is not a question this Worker can answer
// by counting rows in that table: it has to count its OWN rows. Everything
// index.js logs carries this source, and the mail-route check below reads it.
export const INGEST_SOURCE = 'weekly-orders-email';

// Ray publishes the Azamara MLS monthly. A month plus a week of slack.
export const AZAMARA_MAX_SILENCE_DAYS = 40;

import { voyageStates, dataFaults, escalations, MISSED_CREW_DAYS } from './due.js';
import { quantityFindings, rulesFrom } from './quantity.js';
import { anomalyFindings } from './anomaly.js';
import { normShip } from './fleet.js';

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
  //
  // TWO BUGS LIVED IN THIS REPAIR AND BOTH COULD DESTROY DATA.
  //
  // 1. The DELETE had NO WHERE CLAUSE beyond the id test, and its subquery
  //    grouped over the WHOLE TABLE. Detecting a duplicate among our own rows
  //    therefore de-duplicated every other MOT and every other app's rows too,
  //    keeping whichever happened to have the lower id. That breaks design rule
  //    1 and the standing guardrail that each app manages its own rows. Both
  //    the DELETE and its subquery are now scoped to our stream and our sources.
  //
  // 2. It grouped on `voyage`, which is NULL for every Azamara row with no PO,
  //    and SQLite groups NULLs together. Two genuinely different loadings that
  //    happened to share a due date looked like duplicates and one was deleted.
  //    Use the SAME never-null key as due.js - one definition per concept.
  const DUPE_KEY = "ship, COALESCE(voyage, loading_delivery_date, due_date), mot, due_date";
  const SCOPE = `${ELIGIBLE_MOT_SQL} AND source IN ${OWNED_SOURCES}`;
  const dupes = await many(hon,
    `SELECT ship, voyage, mot, due_date, COUNT(*) n FROM schedule_order
      WHERE ${SCOPE}
      GROUP BY ${DUPE_KEY} HAVING COUNT(*) > 1`);
  // Duplicates in rows we do NOT own are reported and left completely alone.
  const foreignDupes = await many(hon,
    `SELECT source, COUNT(*) n FROM (
       SELECT source FROM schedule_order
        WHERE ${ELIGIBLE_MOT_SQL} AND source NOT IN ${OWNED_SOURCES}
        GROUP BY ${DUPE_KEY}, source HAVING COUNT(*) > 1)
      GROUP BY source`);
  if (dupes.length) {
    if (repair) {
      await hon.prepare(
        `DELETE FROM schedule_order
          WHERE ${SCOPE}
            AND id NOT IN (
              SELECT MIN(id) FROM schedule_order
               WHERE ${SCOPE}
               GROUP BY ${DUPE_KEY})`
      ).run();
      repairs.push(`de-duplicated ${dupes.length} voyage rows we wrote`);
    } else add('warn', 'duplicates', `${dupes.length} duplicated voyage rows in our own sources`);
  }
  for (const f of foreignDupes) {
    add('warn', 'duplicates',
      `${f.n} duplicated voyage groups from source "${f.source}" - NOT touched, ${f.source} owns them`);
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

  // ---- 9. Is any mail reaching this Worker at all? ----
  // THE FAILURE THIS EXISTS FOR. On 10 Sep 2026 Ray's MLS bounced back to Ray:
  //   550 5.1.1 Address does not exist  (route1.mx.cloudflare.net)
  // The Cloudflare Email Routing rule for azamara@cims.work had never been
  // created, so the mail never reached this Worker's email() handler. Not one
  // MLS has ever been ingested here. Every other check ran clean, because a
  // feed that has NEVER delivered looks exactly like a feed with nothing new
  // to say - and /health reported 14 azamara-mls rows the whole time, because
  // those were loaded by another path. Ray found out. This system did not.
  //
  // The three cases are kept apart on purpose: each one is a different person
  // doing a different thing, and "the feed is quiet" tells nobody which.
  //   nothing has ever arrived   -> the ROUTE does not exist    (Cloudflare)
  //   mail arrives, no MLS in it -> the route works, the identity test or the
  //                                 format does not             (code, or Ray)
  //   an MLS arrived, long ago   -> Ray has stopped sending     (Ray)
  const lastMls = await one(hon,
    `SELECT MAX(ts) ts FROM ingest_log WHERE note LIKE 'Azamara MLS:%'`);
  const inbound = await one(hon,
    `SELECT COUNT(*) n, MAX(ts) ts FROM ingest_log
      WHERE source = '${INGEST_SOURCE}' AND sender NOT IN ('cron', 'watchdog')`);
  const mlsAge = lastMls.ts
    ? Math.round((Date.parse(today) - Date.parse(String(lastMls.ts).slice(0, 10))) / 86400000)
    : null;

  if (!inbound.n) {
    add('critical', 'mail_route',
      'no email has EVER reached this Worker. The Azamara MLS arrives by mail and nothing else ' +
      'feeds it, so this is not a quiet month - the Email Routing rule for azamara@cims.work is ' +
      'missing or points elsewhere. A bounce on 10 Sep 2026 read 550 5.1.1 "Address does not ' +
      'exist". Any azamara-mls rows already in schedule_order came from another path and are ' +
      'frozen: nothing can refresh them, and a date that moves will not be seen.');
  } else if (mlsAge === null) {
    add('critical', 'mail_route',
      `${inbound.n} emails have reached this Worker and NOT ONE was recognised as an Azamara MLS ` +
      `(the most recent arrived ${inbound.ts}). The route works; the subject and attachment test ` +
      `or Ray's format does not. Every rejected mail is in ingest_log with its subject - read ` +
      `those before changing the test.`);
  } else if (mlsAge > AZAMARA_MAX_SILENCE_DAYS) {
    add('critical', 'mail_route',
      `the last Azamara MLS was ingested ${lastMls.ts}, ${mlsAge} days ago. Ray publishes it ` +
      `monthly, so more than ${AZAMARA_MAX_SILENCE_DAYS} days means it has stopped arriving and ` +
      `the Azamara due dates are going stale.`);
  }

  // ---- 10. Does the ship name in the schedule match the ship name in OBP? ----
  // The whole "is it ordered" test is a join on ship name. If the two sources
  // ever spell a ship differently - "Allure of the Seas" against "Allure" -
  // that ship's order_lines is 0 for every voyage and it is reported as MISSING
  // EVERYTHING, confidently, forever. Or the reverse: a rename makes the fleet
  // look clean. Neither failure raises an error anywhere. Check it explicitly.
  const schedShips = (await many(hon,
    `SELECT DISTINCT ship FROM schedule_order WHERE ${ELIGIBLE_MOT_SQL}`)).map((r) => r.ship);
  const obpShips = (await many(hon,
    `SELECT DISTINCT ship FROM obp_intransit
      WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM obp_intransit)`)).map((r) => r.ship);
  const obpSet = new Set(obpShips.map(normShip));
  const unmatched = schedShips.filter((s2) => s2 && !obpSet.has(normShip(s2)));
  if (obpShips.length && unmatched.length) {
    add(unmatched.length === schedShips.length ? 'critical' : 'warn', 'ship_join',
      `${unmatched.length} of ${schedShips.length} scheduled ships have no name match in the ` +
      `latest OBP in-transit snapshot, so every voyage they have reads as unordered: ` +
      `${unmatched.slice(0, 8).join(', ')}${unmatched.length > 8 ? ', ...' : ''}`);
  }

  // ---- 11. Did the weekly run happen at all? ----
  // The weekly cron used to return silently when nothing was due, which is
  // indistinguishable from the cron never firing. That is not hypothetical: a
  // cron on this Worker has already been wrong twice, once pointing at Sunday
  // and once running the wrong code path entirely. index.js now logs every
  // weekly run including the quiet ones, so an absence here is real.
  const lastWeekly = await one(hon,
    `SELECT MAX(ts) ts FROM ingest_log WHERE sender = 'cron' AND note LIKE 'weekly run%'`);
  const weeklyAge = lastWeekly.ts
    ? Math.round((Date.parse(today) - Date.parse(String(lastWeekly.ts).slice(0, 10))) / 86400000)
    : null;
  if (weeklyAge === null) {
    add('warn', 'weekly_silent', 'no weekly run has ever been logged - the Monday cron may not be firing');
  } else if (weeklyAge > 8) {
    add('critical', 'weekly_silent',
      `the last weekly run was ${lastWeekly.ts} (${weeklyAge} days ago) - the Monday cron has stopped`);
  }

  // ---- 12 to 14. Everything that needs the classified voyage list ----
  // Wrapped: a failure in an added check must never stop the repairs above from
  // being reported. A watchdog that dies mid-run is a watchdog that lies.
  let states = null;
  try {
    states = await voyageStates(hon, today);
  } catch (e) {
    add('critical', 'self_check', `voyageStates failed: ${String(e && e.message || e)}`);
  }

  if (states) {
    // 12. Rows with no due date. They cannot be shown to a ship - a deadline
    // warning with no deadline in it is the exact excuse this system removes -
    // so they are an ingest fault and they belong here, not in the fleet email.
    const faults = dataFaults(states);
    if (faults.length) {
      add('critical', 'no_due_date',
        `${faults.length} of ${states.length} eligible voyages are UNUSABLE - no due date or no loading ` +
        `date - so they can neither be checked nor told to a ship: ` +
        `${faults.slice(0, 5).map((f) => `${f.ship} ${f.loading_delivery_date || 'no loading date'} (${f.state})`).join(', ')}`);
    }

    // Past the cut-off long enough that no crew can act. These leave the weekly
    // email on purpose; if they left it silently as well, a missed container
    // would simply stop being mentioned by anything.
    const stale = escalations(states);
    if (stale.length) {
      add('critical', 'escalation',
        `${stale.length} voyages are more than ${MISSED_CREW_DAYS} days past their cut-off. The ship cannot ` +
        `order these now - they need an emergency-freight decision: ` +
        `${stale.slice(0, 5).map((f) => `${f.ship} due ${f.due_date}`).join(', ')}`);
    }

    // 13. Does the order that exists contain what the ship needs?
    try {
      const q = await quantityFindings(hon, states, rulesFrom(env.QUANTITY_RULES));
      if (!q.ran) {
        add('warn', 'quantity_blocked', `completeness check did not run - ${q.reason}`);
      } else {
        for (const f of q.findings) {
          add(f.severity, 'quantity', `${f.ship} loading ${f.loading_delivery_date}: ${f.detail}`);
        }
      }
    } catch (e) {
      add('warn', 'quantity_blocked', `completeness check threw: ${String(e && e.message || e)}`);
    }
  }

  // 14. Inventory anomalies against each ship's own trailing history.
  try {
    const a = await anomalyFindings(hon);
    if (!a.ran) add('warn', 'anomaly_blocked', `anomaly check did not run - ${a.reason}`);
    else for (const f of a.findings) add(f.severity, 'anomaly', `${f.ship}: ${f.detail}`);
  } catch (e) {
    add('warn', 'anomaly_blocked', `anomaly check threw: ${String(e && e.message || e)}`);
  }

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
