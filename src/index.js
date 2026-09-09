import {
  isAzamaraMls, rowsFromHtml, rowsFromWorkbook, parseAzamaraRows,
  notesFromBody, saveAzamara,
} from './lib/azamaraMls.js';
import { htmlPartOf } from './lib/mime.js';
import { voyageStates, actionable, poNotRecorded } from './lib/due.js';
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

    if (!isAzamaraMls('', subject, body)) return; // not ours; cims-hon keeps its route

    // The table is usually PASTED into the body, not attached - exactly the
    // case the cims-hon handler returns early on.
    const rows = parseAzamaraRows(rowsFromHtml(body));

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
        `Body was ${raw.length} bytes, decoded to ${body.length}.`);
      return;
    }

    const notes = notesFromBody(body.replace(/<[^>]+>/g, ' '));
    const r = await saveAzamara(env.HON, usable, 'azamara-mls');
    await logIngest(env, message.from,
      `Azamara MLS: ${r.written} rows, ${r.missing} with no PO` +
      (notes.length ? ` | notes: ${notes.join(' // ')}` : ''));
  },

  // ---- Two schedules on one handler, split by cron expression ----
  //   "0 6 * * *"   nightly 02:00 Miami - the watchdog
  //   "0 12 * * 2"  Monday  08:00 Miami - the fleet email
  // Cloudflare's day-of-week is 1-based from Sunday, so Monday is 2, not 1.
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

    const { act, html } = await buildWeekly(env, today);
    if (!act.length) return; // nothing due, say nothing

    // FLEET ADDRESSING IS NOT IMPLEMENTED. Setting SEND_TO_FLEET=true must not
    // silently post an empty to[] that cims-mailer rejects with "to[] required".
    // Fail loudly instead.
    if (env.SEND_TO_FLEET === 'true') {
      await logIngest(env, 'cron',
        'SEND_TO_FLEET is true but per-ship addressing is not implemented. Nothing sent.');
      return;
    }
    const to = (env.DRY_RUN_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!to.length) {
      await logIngest(env, 'cron', 'DRY_RUN_TO is empty. Nothing sent.');
      return;
    }
    ctx.waitUntil((async () => {
      const r = await send(env, to, `Orders due this week - ${act.length} to fix`, html);
      if (!r.sent) await logIngest(env, 'cron', `weekly send FAILED: ${JSON.stringify(r)}`);
    })());
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const today = url.searchParams.get('today') || iso(new Date());

    if (url.pathname === '/health') {
      const q = async (sql) => (await env.HON.prepare(sql).first()) || {};
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
      'weekly-orders-email\n\n/health  /preview  /states  /azamara  /po-not-recorded  /watchdog\n',
      { headers: { 'content-type': 'text/plain' } }
    );
  },
};
