import {
  isAzamaraMls, rowsFromHtml, rowsFromWorkbook, parseAzamaraRows,
  notesFromBody, saveAzamara,
} from './lib/azamaraMls.js';
import { voyageStates, actionable } from './lib/due.js';
import { renderWeekly } from './lib/email.js';

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

async function send(env, to, subject, html) {
  if (!env.MAILER_URL || !env.MAILER_TOKEN) {
    return { sent: false, reason: 'MAILER_URL / MAILER_TOKEN not set' };
  }
  const r = await fetch(env.MAILER_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.MAILER_TOKEN}` },
    body: JSON.stringify({ app: 'weekly-orders-email', to, subject, html }),
  });
  return { sent: r.ok, status: r.status };
}

async function buildWeekly(env, today) {
  const rows = await voyageStates(env.HON, today);
  const act = actionable(rows);
  return { rows, act, html: renderWeekly(act, rows, today) };
}

export default {
  // ---- Ray's Azamara MLS lands here ----
  async email(message, env) {
    const subject = message.headers.get('subject') || '';
    let body = '';
    try { body = new TextDecoder().decode(await readAll(message.raw)); } catch (_) { /* best effort */ }

    if (!isAzamaraMls('', subject, body)) {
      // Not ours. Leave it for the cims-hon route.
      return;
    }

    // The table is usually PASTED into the body, not attached. That is exactly
    // the case the cims-hon handler returns early on.
    const rows = parseAzamaraRows(rowsFromHtml(body));
    const notes = notesFromBody(body.replace(/<[^>]+>/g, ' '));
    if (!rows.length) return;

    const r = await saveAzamara(env.HON, rows, 'azamara-mls');
    await env.HON.prepare(
      `INSERT INTO ingest_log (source, sender, note, ts)
       VALUES ('email', ?, ?, datetime('now'))`
    ).bind(
      message.from || 'unknown',
      `Azamara MLS: ${r.written} rows, ${r.missing} with no PO` +
        (notes.length ? ` | notes: ${notes.join(' // ')}` : '')
    ).run().catch(() => {});
  },

  // ---- Monday 08:00 Miami ----
  async scheduled(event, env, ctx) {
    const today = iso(new Date());
    const { act, html } = await buildWeekly(env, today);
    if (!act.length) return; // nothing due, say nothing

    const fleet = env.SEND_TO_FLEET === 'true';
    const to = fleet ? null : (env.DRY_RUN_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
    // Fleet addressing is deliberately not implemented until SEND_TO_FLEET is
    // reviewed: see README. Until then this goes to Miguel and Ray only.
    ctx.waitUntil(send(env, to, `Orders due this week - ${act.length} to fix`, html));
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
        mailer_configured: Boolean(env.MAILER_URL && env.MAILER_TOKEN),
        schedule_rows: (await q('SELECT COUNT(*) n FROM schedule_order')).n,
        azamara_rows: (await q("SELECT COUNT(*) n FROM schedule_order WHERE source='azamara-mls'")).n,
        intransit_snapshot: (await q('SELECT MAX(snapshot_date) d FROM obp_intransit')).d,
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

    if (url.pathname === '/states') {
      const rows = await voyageStates(env.HON, today);
      return json(rows);
    }

    return new Response(
      'weekly-orders-email\n\n/health  /preview  /states  /azamara\n',
      { headers: { 'content-type': 'text/plain' } }
    );
  },
};
