import {
  isAzamaraMls, rowsFromHtml, parseAzamaraRows,
  notesFromBody, saveAzamara,
} from './lib/azamaraMls.js';
import { htmlPartOf, attachmentsOf } from './lib/mime.js';
import { voyageStates, actionable, poNotRecorded, dataFaults, escalations, MISSED_CREW_DAYS } from './lib/due.js';
import { planFleetSend, maskEmail } from './lib/fleet.js';
import { quantityFindings, rulesFrom } from './lib/quantity.js';
import { anomalyFindings } from './lib/anomaly.js';
import { renderWeekly } from './lib/email.js';
import { runWatchdog } from './lib/watchdog.js';
import { renderWatchdog } from './lib/watchdogEmail.js';

// MUST match the nightly entry in wrangler.toml exactly. It is the only thing
// telling the watchdog run apart from the Monday fleet run inside one
// scheduled() handler. If they ever disagree, the nightly trigger runs the
// WEEKLY EMAIL every night - which is exactly what happened when the cron was
// added before this file was.
const NIGHTLY_CRON = '0 6 * * *';

const iso = (d) => d.toISOString().slice(0, 10);
const json = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'content-type': 'application/json' } });

async function readAll(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const len = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// TRANSPORT. Per the CIMS email standard section 4, every app sends through
// cims-mailer via a SERVICE BINDING - env.MAILER.fetch('https://mailer/send').
// There is no URL and no bearer token in this estate; cims-mailer holds the only
// Resend key and reads no Authorization header. An earlier version of this file
// invented MAILER_URL / MAILER_TOKEN, which is how a Resend key ended up pasted
// into a plaintext Worker variable. Do not reintroduce them.
//
// cims-mailer's validate() hard-rejects a payload without templateId, and
// ALLOWED_FROM holds exactly three senders. Anything a human is waiting on is
// critical: true.
async function send(env, to, subject, html, templateId = 'orders-due-weekly') {
  if (!env.MAILER) return { sent: false, reason: 'MAILER service binding not configured' };
  const res = await env.MAILER.fetch('https://mailer/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'weekly-orders-email',
      templateId,
      from: 'CIMS <cims@cims.work>',
      to,
      subject,
      html,
      critical: true,
    }),
  });
  const body = await res.text().catch(() => '');
  // Never swallow this. A silent send failure is the same class of bug as a
  // silent parse failure: the system looks healthy and nobody is warned.
  return { sent: res.ok, status: res.status, body: body.slice(0, 300) };
}

// Length-independent compare. The value it guards is a read-only list of
// mailboxes rather than anything that moves money, but a timing-leaky compare
// is not cheaper to write than this one.
function secretEquals(given, expected) {
  const a = String(given == null ? '' : given);
  const b = String(expected == null ? '' : expected);
  if (!b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function buildWeekly(env, today) {
  const rows = await voyageStates(env.HON, today);
  const act = actionable(rows);
  return { rows, act, html: renderWeekly(act, rows, today) };
}

async function logIngest(env, sender, note) {
  try {
    await env.HON.prepare(
      `INSERT INTO ingest_log (source, sender, note, ts) VALUES ('email', ?, ?, datetime('now'))`
    ).bind(sender || 'unknown', note).run();
  } catch (_) { /* logging must never block the ingest */ }
}

export default {
  // ---- Ray's Azamara MLS lands here ----
  async email(message, env) {
    const subject = message.headers.get('subject') || '';

    let raw = '';
    try { raw = new TextDecoder().decode(await readAll(message.raw)); } catch (_) { /* best effort */ }

    // DECODE BEFORE PARSING. Outlook sends quoted-printable or base64; handing
    // raw MIME to the HTML parser drops rows and writes nulls. See lib/mime.js.
    const body = htmlPartOf(raw) || raw;

    // Attachment names are part of the identity test. Ray was asked to attach
    // the MLS as well as pasting it, and a mail whose subject drifted may still
    // be identifiable by its filename.
    const attachments = attachmentsOf(raw);
    const names = attachments.map((a) => a.filename).join(' ');

    if (!isAzamaraMls(names, subject, body)) {
      // DO NOT DISCARD SILENTLY. On 9 Sep eighteen ships replied with their
      // ordering schedules and every one was rejected and thrown away with no
      // record: not parked, not queued, not recoverable. A one-line log costs
      // nothing and turns "the files vanished" into "here is what arrived".
      await logIngest(env, message.from,
        `not an Azamara MLS, ignored: subject "${subject.slice(0, 90)}"` +
        (names ? ` | attachments: ${names.slice(0, 140)}` : ' | no attachments'));
      return; // cims-hon keeps its own route
    }

    // The table is usually PASTED into the body, not attached - exactly the
    // case the cims-hon handler returns early on.
    const rows = parseAzamaraRows(rowsFromHtml(body));

    // The workbook path exists (rowsFromWorkbook, xlsx injected by the caller)
    // but no library is bundled into this Worker, so an attached .xlsx is NOT
    // parsed. Say so rather than let it look handled: the attachment keeps the
    // cell colours, and colour is data in this file.
    const workbooks = attachments.filter((a) => /\.xlsx?$/i.test(a.filename));

    // REFUSE A PARTIAL WRITE. A run that finds the file but parses nothing, or
    // parses rows with no loading date, means the decode or the layout changed.
    // Writing those rows corrupts schedule_order and the corruption is silent -
    // a null loading date drops that ship out of the weekly email entirely,
    // which is the exact failure this Worker exists to prevent.
    // Log loudly and change nothing.
    const usable = rows.filter((r) => r.due_date && r.loading_delivery_date);
    if (!rows.length || usable.length < rows.length) {
      await logIngest(env, message.from,
        `Azamara MLS REFUSED: parsed ${rows.length} rows, ${usable.length} usable ` +
        `(need a loading date on every row). schedule_order left unchanged. ` +
        `Body was ${raw.length} bytes, decoded to ${body.length}.` +
        (workbooks.length
          ? ` ${workbooks.length} workbook attachment(s) present (${workbooks.map((w) => w.filename).join(', ')}) ` +
            `but the workbook parser is not wired in this Worker - the data may be in there.`
          : ''));
      return;
    }

    const notes = notesFromBody(body.replace(/<[^>]+>/g, ' '));
    const r = await saveAzamara(env.HON, usable, 'azamara-mls');
    await logIngest(env, message.from,
      `Azamara MLS: ${r.written} rows, ${r.missing} with no PO` +
      (notes.length ? ` | notes: ${notes.join(' // ')}` : ''));
  },

  // ---- Two schedules on one handler, split by cron expression ----
  //   "0 6 * * *"     nightly 02:00 Miami - the watchdog
  //   "0 12 * * MON"  Monday  08:00 Miami - the fleet email
  // The weekly uses the NAME "MON", not a number. Cloudflare's day-of-week
  // field is 1-7 with 1 = SUNDAY, which is not the Unix convention most people
  // carry in their head, and "0 12 * * 1" therefore scheduled this for Sunday.
  // This comment said "0 12 * * 2" long after wrangler.toml had been corrected
  // to MON; a stale comment about a cron is how the last cron bug survived.
  async scheduled(event, env, ctx) {
    const today = iso(new Date());

    if (event.cron === NIGHTLY_CRON) {
      const report = await runWatchdog(env, today, { repair: true });
      await logIngest(env, 'watchdog',
        report.healthy
          ? 'night check clean'
          : `night check: ${report.counts.critical} critical, ${report.counts.warn} warn, ${report.repairs.length} repaired`);
      if (report.healthy) return; // silence means healthy

      // The night check is an ENGINEERING digest - stale feeds, format drift,
      // rows repaired. Ray does not need it and must not get it: he is the
      // person the fleet email is signed by, and ops noise in his inbox is how
      // a useful alert becomes something he filters. WATCHDOG_TO is Miguel only.
      const to = (env.WATCHDOG_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!to.length) {
        await logIngest(env, 'watchdog', 'WATCHDOG_TO is empty. Findings logged, nothing sent.');
        return;
      }
      ctx.waitUntil((async () => {
        const subject = report.counts.critical
          ? `Night check - ${report.counts.critical} need${report.counts.critical === 1 ? 's' : ''} a human`
          : `Night check - ${report.counts.warn} warning${report.counts.warn === 1 ? '' : 's'}, ${report.repairs.length} repaired`;
        const r = await send(env, to, subject, renderWatchdog(report), 'orders-watchdog-night');
        if (!r.sent) await logIngest(env, 'watchdog', `digest send FAILED: ${JSON.stringify(r)}`);
      })());
      return;
    }

    const { rows, act, html } = await buildWeekly(env, today);

    // LOG EVERY WEEKLY RUN, INCLUDING THE QUIET ONES.
    // This used to return silently when nothing was due, which looks EXACTLY
    // like the cron not firing - and the cron on this Worker has already been
    // wrong twice. The watchdog's weekly_silent check reads this line, so a
    // quiet Monday now proves the run happened instead of proving nothing.
    const faults = dataFaults(rows);
    const stale = escalations(rows);
    await logIngest(env, 'cron',
      `weekly run: ${act.length} actionable of ${rows.length} eligible voyages` +
      (stale.length ? `, ${stale.length} past the cut-off by more than ${MISSED_CREW_DAYS} days (escalation, not the crew's)` : '') +
      (faults.length ? `, ${faults.length} unusable rows (engineering)` : ''));
    if (!act.length) return; // nothing due, say nothing to anybody

    const supervisors = (env.DRY_RUN_TO || '').split(',').map((x) => x.trim()).filter(Boolean);

    // ---- DRY RUN: the whole fleet list, to Miguel and Ray only ----
    if (env.SEND_TO_FLEET !== 'true') {
      if (!supervisors.length) {
        await logIngest(env, 'cron', 'DRY_RUN_TO is empty. Nothing sent.');
        return;
      }
      ctx.waitUntil((async () => {
        const r = await send(env, supervisors, `Orders due this week - ${act.length} to fix`, html);
        if (!r.sent) await logIngest(env, 'cron', `weekly send FAILED: ${JSON.stringify(r)}`);
      })());
      return;
    }

    // ---- LIVE: one email per ship, to that ship only ----
    //
    // An address is used only if a human put it in FLEET_MAP. Nothing here
    // derives a mailbox from a ship name: a guessed address either bounces,
    // which is useless, or reaches a real stranger carrying another company's
    // operational data, which is worse than useless.
    //
    // A ship with no mapping is NOT dropped. Its rows are still in the full
    // fleet list that goes to the supervisors, the subject line counts them,
    // and a log line names them - because the ships nobody can reach are the
    // ones most likely to miss a container.
    const plan = planFleetSend(act, env.FLEET_MAP);
    if (!plan.sendable.length) {
      await logIngest(env, 'cron',
        `SEND_TO_FLEET is true but NONE of the ${plan.unmapped.length} ships due this week ` +
        `has an address in FLEET_MAP (${plan.mapped_ships} ships mapped in total). ` +
        `Nothing sent to the fleet.`);
    }
    ctx.waitUntil((async () => {
      let sent = 0;
      const failed = [];
      // EVERY SEND IS ISOLATED. send() awaits a fetch on the MAILER binding, and
      // a fetch REJECTS on a transport error rather than returning a status. One
      // such rejection used to abort this loop, so ship 12 failing meant ships
      // 13 to 48 were never mailed, no failure was logged, and the supervisor
      // digest below never ran either - a silent partial send, which is the one
      // outcome worse than not sending at all.
      for (const group of plan.sendable) {
        const n = group.rows.length;
        try {
          const r = await send(
            env,
            group.to,
            `${group.ship}: ${n} order${n === 1 ? '' : 's'} due this week`,
            renderWeekly(group.rows, rows, today, { audience: 'ship', ship: group.ship })
          );
          if (r.sent) sent++;
          else failed.push(`${group.ship} -> ${group.to.join(',')}: ${JSON.stringify(r)}`);
        } catch (e) {
          failed.push(`${group.ship} -> ${group.to.join(',')}: threw ${String((e && e.message) || e)}`);
        }
      }
      // One line per run, not one per ship: the log is evidence, not a feed.
      await logIngest(env, 'cron',
        `weekly fleet send: ${sent} of ${plan.sendable.length} ships mailed` +
        (plan.unmapped.length ? `, ${plan.unmapped.length} unaddressable` : '') +
        (plan.malformed.length ? `, ${plan.malformed.length} malformed FLEET_MAP entries` : ''));
      for (const f of failed) await logIngest(env, 'cron', `weekly send FAILED: ${f}`);

      // The supervisors always get the full picture, live or not.
      if (supervisors.length) {
        const unreachable = plan.unmapped.flatMap((g) => g.rows);
        try {
          const r = await send(env, supervisors,
            `Orders due this week - ${act.length} to fix, ${sent} ships mailed` +
            (unreachable.length ? `, ${plan.unmapped.length} unaddressable` : ''),
            html);
          if (!r.sent) await logIngest(env, 'cron', `weekly supervisor send FAILED: ${JSON.stringify(r)}`);
        } catch (e) {
          await logIngest(env, 'cron', `weekly supervisor send THREW: ${String((e && e.message) || e)}`);
        }
        if (unreachable.length) {
          await logIngest(env, 'cron',
            `NOT DELIVERED - no FLEET_MAP entry: ${plan.unmapped.map((g) => g.ship).join(', ')}`);
        }
      }
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const today = url.searchParams.get('today') || iso(new Date());

    if (url.pathname === '/health') {
      const q = async (sql) => (await env.HON.prepare(sql).first()) || {};
      const fleetMap = planFleetSend([], env.FLEET_MAP);
      return json({
        version: env.VERSION || 'dev',
        today,
        send_to_fleet: env.SEND_TO_FLEET === 'true',
        mailer_configured: Boolean(env.MAILER),
        watchdog_recipients: Boolean(env.WATCHDOG_TO),
        schedule_rows: (await q('SELECT COUNT(*) n FROM schedule_order')).n,
        azamara_rows: (await q("SELECT COUNT(*) n FROM schedule_order WHERE source='azamara-mls'")).n,
        intransit_snapshot: (await q('SELECT MAX(snapshot_date) d FROM obp_intransit')).d,
        // Coverage, not just row counts. If this shows only AZAMARA BWS then the
        // weekly email cannot flag a single Royal or Celebrity ship, whatever
        // the row count says.
        mots_present: (await q('SELECT GROUP_CONCAT(DISTINCT mot) m FROM schedule_order')).m,
        // Addressing readiness. send_to_fleet true with fleet_mapped 0 means
        // the Monday cron will reach nobody, which is worth seeing here rather
        // than discovering from an empty inbox on Tuesday.
        fleet_mapped: fleetMap.mapped_ships,
        fleet_map_malformed: fleetMap.malformed.length,
      });
    }

    // WHO WOULD GET WHAT, before anything is sent. Run this and read it before
    // ever setting SEND_TO_FLEET to true.
    //
    // ADDRESSES ARE MASKED UNLESS ADMIN_KEY IS SET AND MATCHED. No endpoint on
    // this Worker has any authentication, and a Workers Build publishes a
    // preview URL for every commit, so an unmasked list here is every printer
    // in the fleet, tied to their ship, on a public URL. Masked is still enough
    // to check that a ship is mapped and that its domain is right.
    if (url.pathname === '/fleet') {
      const st = await voyageStates(env.HON, today);
      const plan = planFleetSend(actionable(st), env.FLEET_MAP);
      const unlocked = Boolean(env.ADMIN_KEY) && secretEquals(url.searchParams.get('key'), env.ADMIN_KEY);
      const show = (addrs) => (unlocked ? addrs : addrs.map(maskEmail));
      return json({
        today,
        send_to_fleet: env.SEND_TO_FLEET === 'true',
        addresses: unlocked
          ? 'full'
          : env.ADMIN_KEY
            ? 'masked - pass ?key=<ADMIN_KEY> to see them in full'
            : 'masked - set ADMIN_KEY to be able to see them in full',
        mapped_ships: plan.mapped_ships,
        // Malformed entries are echoed back, and a malformed line may itself
        // contain an address. Mask the whole line rather than leak it here.
        malformed_entries: unlocked ? plan.malformed : plan.malformed.map((l) => l.replace(/\S+@\S+/g, '***')),
        would_send: plan.sendable.map((g) => ({
          ship: g.ship, to: show(g.to), orders: g.rows.length,
          due: g.rows.map((r) => `${r.due_date} ${r.state}`),
        })),
        // The half that matters most: due this week and unreachable.
        unaddressable: plan.unmapped.map((g) => ({
          ship: g.ship, orders: g.rows.length,
          due: g.rows.map((r) => `${r.due_date} ${r.state}`),
        })),
      });
    }

    // A ship's own email, exactly as that ship would receive it. ?ship=Apex
    if (url.pathname === '/preview-ship') {
      const want = url.searchParams.get('ship') || '';
      const st = await voyageStates(env.HON, today);
      const plan = planFleetSend(actionable(st), env.FLEET_MAP);
      const g = [...plan.sendable, ...plan.unmapped]
        .find((x) => x.ship.toLowerCase().includes(want.toLowerCase()));
      if (!want || !g) {
        return json({
          error: want ? `no ship matching "${want}" has anything due this week` : 'pass ?ship=',
          available: [...plan.sendable, ...plan.unmapped].map((x) => x.ship),
        }, 404);
      }
      return new Response(
        renderWeekly(g.rows, st, today, { audience: 'ship', ship: g.ship }),
        { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // Does the order that exists actually contain what the ship needs?
    // ran:false is NOT a clean bill of health - read `reason`.
    if (url.pathname === '/quantity') {
      const st = await voyageStates(env.HON, today);
      return json(await quantityFindings(env.HON, st, rulesFrom(env.QUANTITY_RULES)));
    }

    // Inventory readings that do not look like this ship's own history.
    if (url.pathname === '/anomalies') {
      return json(await anomalyFindings(env.HON));
    }

    // WHY each miss happened, derived from the row itself.
    //
    // This READS ONLY. cims-order's miss ledger belongs to cims-order and the
    // standing guardrail is that each app manages its own rows, so nothing here
    // writes `miss_note` - it produces the values a human can decide to load.
    if (url.pathname === '/misses') {
      const st = await voyageStates(env.HON, today);
      const notable = st.filter((r) => r.miss_note);
      return json({
        today,
        population: st.length,
        explained: notable.length,
        note: 'read-only: cims-order owns the miss ledger, this Worker does not write to it',
        misses: notable.map((r) => ({
          ship: r.ship, voyage: r.voyage, state: r.state,
          due_date: r.due_date, loading_delivery_date: r.loading_delivery_date,
          miss_note: r.miss_note,
        })),
      });
    }

    // Voyages our own data has broken - no due date or no loading date, so
    // nothing can be told to a ship. Engineering's list, never the crew's.
    if (url.pathname === '/data-faults') {
      const st = await voyageStates(env.HON, today);
      return json({ today, population: st.length, faults: dataFaults(st) });
    }

    // Past the cut-off by more than MISSED_CREW_DAYS. The ship cannot raise
    // these any more, so they stop going to the crew and become a decision for
    // Ray and Miguel about emergency freight. Never dropped, just re-addressed.
    if (url.pathname === '/escalations') {
      const st = await voyageStates(env.HON, today);
      return json({
        today,
        crew_window_days: MISSED_CREW_DAYS,
        note: 'the due date is hard - a crew cannot act on these, so they leave the weekly email',
        escalations: escalations(st),
      });
    }

    if (url.pathname === '/azamara') {
      const r = await env.HON.prepare(
        `SELECT ship, loading_port, due_date, loading_delivery_date, po_number, po_state, date_changed
           FROM schedule_order WHERE source='azamara-mls' ORDER BY due_date`
      ).all();
      return json(r.results || []);
    }

    if (url.pathname === '/preview') {
      const { html } = await buildWeekly(env, today);
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }

    // The MLS and OBP disagree about whether these orders exist. Ray's list,
    // never the ships'. Exposed so the discrepancy is surfaced, not discarded.
    if (url.pathname === '/po-not-recorded') {
      const rows = await voyageStates(env.HON, today);
      return json(poNotRecorded(rows));
    }

    // Run every check with repair OFF, so findings can be read before anything
    // is deleted. ?html=1 renders the digest exactly as it would be mailed.
    if (url.pathname === '/watchdog') {
      const report = await runWatchdog(env, today, { repair: false });
      return url.searchParams.get('html') === '1'
        ? new Response(renderWatchdog(report), { headers: { 'content-type': 'text/html; charset=utf-8' } })
        : json(report);
    }

    if (url.pathname === '/states') {
      const rows = await voyageStates(env.HON, today);
      return json(rows);
    }

    return new Response(
      'weekly-orders-email\n\n' +
      '/health         deploy version, row counts, MOT coverage, addressing readiness\n' +
      '/preview        the fleet email as HTML, without sending it\n' +
      '/preview-ship   ?ship=Apex - one ship\'s own email, as that ship would get it\n' +
      '/fleet          who would be mailed, and which ships are unaddressable\n' +
      '/states         every eligible voyage and its classification\n' +
      '/azamara        what the MLS parser currently holds\n' +
      '/po-not-recorded  MLS and OBP disagree - Ray\'s list, never a ship\'s\n' +
      '/quantity       does the order that exists contain all four toners\n' +
      '/anomalies      inventory readings unlike this ship\'s own history\n' +
      '/misses         why each miss happened (read-only, cims-order owns the ledger)\n' +
      '/data-faults    voyages with no due or loading date - unusable, engineering only\n' +
      '/escalations    misses too old for a crew to act on - Ray and Miguel decide\n' +
      '/watchdog       every night check with repair OFF; ?html=1 renders the digest\n',
      { headers: { 'content-type': 'text/plain' } }
    );
  },
};
