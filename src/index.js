import {
  isAzamaraMls, rowsFromHtml, rowsFromWorkbook, parseAzamaraRows,
  notesFromBody, saveAzamara,
} from './lib/azamaraMls.js';
import { htmlPartOf, attachmentsOf } from './lib/mime.js';
// SheetJS community build, bundled by wrangler. Reads Ray's attached MLS
// workbook when the table is not pasted into the body (11 Sep 2026: 'Azamara
// MLS REFUSED ... 1 workbook attachment present but the workbook parser is
// not wired'). Cell fills are not read by this build - see rowsFromWorkbook.
import * as XLSX from 'xlsx';
import { voyageStates, actionable, poNotRecorded, dataFaults, escalations, MISSED_CREW_DAYS } from './lib/due.js';
import { planFleetSend, parseFleetMap, maskEmail, normShip } from './lib/fleet.js';
import { quantityFindings, rulesFrom } from './lib/quantity.js';
import { anomalyFindings } from './lib/anomaly.js';
import { unscheduledGaps } from './lib/fallback.js';
import { fleetRunway } from './lib/runwayDb.js';
import { inService } from './lib/fleetStatus.js';
import { renderWeekly } from './lib/email.js';
import { runWatchdog, rememberFindings, markMailed, INGEST_SOURCE } from './lib/watchdog.js';
import { renderChase, chaseSubject, CHASE_TEMPLATE } from './lib/chaseEmail.js';
import { scheduleStatuses, needsSchedule } from './lib/scheduleStatus.js';
import { isObpCsvMail, ingestObpCsv } from './lib/obpCsv.js';
import { obpSource } from './lib/obpSource.js';
import { renderWatchdog } from './lib/watchdogEmail.js';
import { fleetCoverage } from './lib/coverage.js';
import { onDemandOutcome } from './lib/sendNote.js';

// MUST match the nightly entry in wrangler.toml exactly. It is the only thing
// telling the watchdog run apart from the Monday fleet run inside one
// scheduled() handler. If they ever disagree, the nightly trigger runs the
// WEEKLY EMAIL every night - which is exactly what happened when the cron was
// added before this file was.
const NIGHTLY_CRON = '0 6 * * *';
// The Monday fleet email. Named, and matched EXPLICITLY below: the weekly
// path used to be "whatever is not the nightly", which is one added cron
// away from mailing the fleet at the wrong hour.
const WEEKLY_CRON = '0 12 * * MON';
// ON-DEMAND SENDS. Every 15 minutes the Worker looks at weekly_send_request
// (its own table) and sends the queued ship emails. This exists because the
// Worker has no HTTP surface a session can reach (ADMIN_KEY unset, workers.dev
// blocked from the container), and Miguel, 16 Sep 2026: "trigger the workflow
// and pick one ship for testing." A row in D1 is the trigger. One SELECT per
// tick; buildWeekly runs only when a row is pending.
const REQUEST_CRON = '*/15 * * * *';
// THE MONTHLY CHASE. Miguel, 17 Sep 2026: "schedule this email on the 2nd day
// of each month and trigger all ships who are not in compliance." On the 2nd
// at 13:00 UTC (an hour after a Monday fleet email, so the two never land in
// the same minute) the Worker queues a '*' chase row and runs the queue: one
// email per ship missing its Ordering Schedule, Ray in cc, 24-hour deadline.
// It goes through the same queue as a hand-fired chase, so the row's result
// and the ingest_log line are the record either way. Nothing is sent when no
// ship is missing.
const MONTHLY_CHASE_CRON = '0 13 2 * *';

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
// replyTo: where a crew's reply lands. The mail is FROM cims@cims.work, which
// no person reads; a printer who hits reply must reach Ray (REPLY_TO), the one
// person who can answer. Sent only when set, so the watchdog digest is unchanged.
// idempotencyKey: cims-mailer keeps mail_log.idempotency_key UNIQUE, so a
// re-fired cron or a retried queue row cannot mail the same ship twice for
// the same reason on the same day (review of 17 Sep 2026: the Monday path
// had no such guard).
async function send(env, to, subject, html, templateId = 'orders-due-weekly', cc = [], replyTo = null, idempotencyKey = null) {
  if (!env.MAILER) return { sent: false, reason: 'MAILER service binding not configured' };
  const res = await env.MAILER.fetch('https://mailer/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      app: 'weekly-orders-email',
      templateId,
      from: 'CIMS <cims@cims.work>',
      to,
      // cc is in the cims-mailer envelope (email standard, section 4). Sent
      // only when there is someone to copy, so the dry run and the watchdog
      // post the same body they always did.
      ...(cc && cc.length ? { cc } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
      subject,
      html,
      critical: true,
    }),
  });
  const body = await res.text().catch(() => '');
  // cims-mailer answers a repeated idempotency key with {ok:true, dedup:true}
  // and sends nothing: still "sent" (it went out once), but say so.
  let dedup = false;
  try { dedup = Boolean(JSON.parse(body).dedup); } catch (_) { /* not JSON */ }
  // Never swallow this. A silent send failure is the same class of bug as a
  // silent parse failure: the system looks healthy and nobody is warned.
  return { sent: res.ok, dedup, status: res.status, body: body.slice(0, 300) };
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

// The subject line of one ship's email: what is actually inside it.
function shipSubject(ship, { rows = [], runsOut = [], gaps = [], ask = [] }) {
  const n = rows.length;
  const same = (x) => normShip(x.ship) === normShip(ship);
  const dry = runsOut.filter(same).length;
  const hasGap = gaps.some(same);
  const needs = ask.some(same);
  return [
    n ? `${n} order${n === 1 ? '' : 's'} due` : null,
    dry ? `${dry} running out` : null,
    !n && !dry && hasGap ? 'a gap in your deliveries' : null,
    needs ? 'send your Ordering Schedule' : null,
  ].filter(Boolean).join(', ') || 'nothing to do this week';
}

const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; } };

// Queued sends. A row names a ship and, optionally, addresses; with none given
// the ship's FLEET_MAP mailbox is used, so every address is still one a human
// typed. SHIP_CC (Ray) is copied as on a Monday, plus whatever cc the row adds.
//
// kind = 'weekly' (default) sends the ship its Monday email now.
// kind = 'chase' sends the "send your Ordering Schedule file" email (Miguel,
// 17 Sep 2026: one per ship, Ray in cc, always 24 hours). A ship that is not
// missing its schedule is skipped, not mailed. ship = '*' with kind 'chase'
// queues every missing ship at once, one email each:
//   INSERT INTO weekly_send_request (ship, kind, note) VALUES ('*', 'chase', 'Ray asked, 17 Sep');
export const SEND_KINDS = ['weekly', 'chase'];

async function ensureSendRequestTable(hon) {
  await hon.prepare(
    `CREATE TABLE IF NOT EXISTS weekly_send_request (
       id INTEGER PRIMARY KEY AUTOINCREMENT, ship TEXT NOT NULL, to_json TEXT, cc_json TEXT, note TEXT,
       requested_at TEXT NOT NULL DEFAULT (datetime('now')), done_at TEXT, result TEXT, kind TEXT)`).run();
  // The table predates 'kind' (16 Sep). Add it once; D1 refuses a duplicate.
  const cols = ((await hon.prepare('PRAGMA table_info(weekly_send_request)').all()).results || []).map((c) => c.name);
  if (cols.length && !cols.includes('kind')) await hon.prepare('ALTER TABLE weekly_send_request ADD COLUMN kind TEXT').run();
}

async function runSendRequests(env, today) {
  const hon = env.HON;
  await ensureSendRequestTable(hon);
  const pending = (await hon.prepare(
    `SELECT id, ship, to_json, cc_json, note, kind, result FROM weekly_send_request WHERE done_at IS NULL ORDER BY id LIMIT 5`).all()).results || [];
  if (!pending.length) return 0;

  const { rows, act, gaps, runsOut, deliveries, schedules, schedulesRan, schedulesReason } = await buildWeekly(env, today);
  const ask = needsSchedule(schedules);
  const plan = planFleetSend(act, env.FLEET_MAP, gaps, runsOut, schedules);
  const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
  const replyTo = list(env.REPLY_TO)[0] || null;
  const { map: fleet } = parseFleetMap(env.FLEET_MAP);
  const sentAtMs = Date.now();
  let sent = 0;

  // One ship, one email. Returns the mailer result or a {sent:false} reason.
  async function sendOne(q, ship, kind) {
    const key = normShip(ship);
    const mapped = plan.sendable.find((g) => normShip(g.ship) === key);
    const group = mapped || plan.unmapped.find((g) => normShip(g.ship) === key);
    let to = parseList(q.to_json);
    if (!to.length && mapped) to = mapped.to;
    if (!to.length && fleet.get(key)) to = fleet.get(key).to;
    if (!to.length) return { sent: false, to, reason: `no address for ${ship}: not in FLEET_MAP and none given` };
    const cc = [...new Set([...list(env.SHIP_CC), ...parseList(q.cc_json)])];
    const shipName = group ? group.ship : (fleet.get(key) ? fleet.get(key).ship : ship);
    if (kind === 'chase') {
      const missing = ask.find((s) => normShip(s.ship) === key);
      if (!missing) return { sent: false, to, reason: `${shipName} is not missing its Ordering Schedule, not chased` };
      const r = await send(env, to, chaseSubject(shipName),
        renderChase({ ship: shipName, missing: ask, sentAtMs }), CHASE_TEMPLATE, cc, replyTo, `chase:${q.id}:${key}`);
      return { ...r, to };
    }
    const shipRows = group ? group.rows : [];
    const r = await send(env, to,
      `${shipName}: ${shipSubject(shipName, { rows: shipRows, runsOut, gaps, ask })}`,
      renderWeekly(shipRows, rows, today, { audience: 'ship', ship: shipName, gaps, runsOut, deliveries, schedules }),
      'orders-due-weekly', cc, replyTo, `req:${q.id}:${key}`);
    return { ...r, to };
  }

  for (const q of pending) {
    // CLAIM THE ROW FIRST. Two cron invocations can share a minute (the review
    // of PR #18 found the monthly chase doing exactly that), and a row that is
    // only marked done after its sends would be sent by both. One UPDATE on
    // "done_at IS NULL" is atomic in D1: whoever changes zero rows moves on.
    const claim = await hon.prepare(
      `UPDATE weekly_send_request SET done_at = datetime('now'), result = 'claimed' WHERE id = ?1 AND done_at IS NULL`)
      .bind(q.id).run();
    if (claim && claim.meta && Number(claim.meta.changes) === 0) continue;
    const kind = SEND_KINDS.includes(q.kind) ? q.kind : 'weekly';
    let result;
    const lines = [];
    try {
      if (!SEND_KINDS.includes(q.kind || 'weekly')) throw new Error(`unknown kind '${q.kind}'`);
      if (q.ship === '*' && kind !== 'chase') throw new Error("ship '*' is only for kind 'chase'");
      // A CHASE NEEDS THE JUDGEMENT TO HAVE RUN. If the schedule check threw,
      // "nobody is missing" is not known, it is unknown: give the row back to
      // the queue (un-claim it) and say why, instead of consuming it as done.
      if (kind === 'chase' && !schedulesRan) {
        const already = String(q.result || '').startsWith('waiting:');
        await hon.prepare(`UPDATE weekly_send_request SET done_at = NULL, result = ?2 WHERE id = ?1`)
          .bind(q.id, `waiting: schedule status check did not run (${String(schedulesReason || 'unknown').slice(0, 200)})`).run();
        // Said once, not every 15 minutes: the night check (queue_stuck) is
        // the alarm if it stays this way for hours.
        if (!already) await logIngest(env, 'cron', `on-demand chase #${q.id} ${q.ship}: schedule status check did not run (${schedulesReason}); row left pending and retried every 15 minutes`);
        continue;
      }
      const targets = q.ship === '*'
        ? (kind === 'chase' ? ask.map((s) => s.ship) : [])
        : [q.ship];
      const results = [];
      for (const ship of targets) {
        // EVERY SHIP IS ISOLATED, as on a Monday: one transport error must not
        // end the month's chase for the ships after it.
        let r;
        try { r = await sendOne(q, ship, kind); }
        catch (e) { r = { sent: false, to: [], threw: String((e && e.message) || e).slice(0, 200) }; }
        if (r.sent) sent++;
        results.push({ ship, ...r });
        lines.push(`${ship} -> ${(r.to || []).join(', ') || '(no address)'}: ${r.sent ? 'sent' : 'NOT SENT ' + (r.reason || r.threw || r.error || JSON.stringify(r))}`);
      }
      result = (q.ship !== '*' && targets.length === 1)
        ? results[0]
        : { sent: results.some((r) => r.sent), count: results.filter((r) => r.sent).length, of: targets.length, ships: results.map((r) => `${r.ship}:${r.sent ? 'sent' : 'no'}`) };
      if (!targets.length) result = { sent: false, reason: 'nothing to send: no ship is missing its Ordering Schedule' };
    } catch (e) {
      result = { sent: false, threw: String((e && e.message) || e).slice(0, 300) };
    }
    // The record must be written even if D1 hiccups: a row left 'claimed'
    // with nothing said is the one outcome the night check has to catch
    // (queue_stuck), so at least name it in the log.
    try {
      await hon.prepare(`UPDATE weekly_send_request SET done_at = datetime('now'), result = ?2 WHERE id = ?1`)
        .bind(q.id, JSON.stringify(result).slice(0, 600)).run();
    } catch (e) {
      lines.push(`(result could not be recorded: ${String((e && e.message) || e).slice(0, 120)})`);
    }
    await logIngest(env, 'cron',
      `on-demand ${kind} send #${q.id} ${q.ship}: ` +
      onDemandOutcome({ lines, result }) +
      (result.threw ? ` | THREW ${result.threw}` : '') +
      (q.note ? ` | ${q.note}` : ''));
  }
  return sent;
}

async function buildWeekly(env, today) {
  // A THROW HERE MUST NOT TAKE THE EMAIL WITH IT. The gap and runway checks
  // were already isolated; this one was not, so one D1 error on the schedule
  // query meant no email, no 'weekly run' log line, and the watchdog only
  // noticing eight days later. A partial email beats none.
  // EVERY DATA SOURCE THIS RUN DEPENDS ON, AND WHETHER IT ANSWERED. A check
  // that did not run used to leave an empty findings array, which reads exactly
  // like a healthy fleet - see coverage.js. Nothing is inferred from silence
  // any more: each check says so itself.
  const checks = [];
  let rows = [];
  try {
    rows = await voyageStates(env.HON, today);
    checks.push({ name: 'voyage', ran: true });
  } catch (e) {
    const reason = String(e && e.message || e);
    checks.push({ name: 'voyage', ran: false, reason });
    await logIngest(env, 'cron', `schedule check threw: ${reason}`);
  }
  // A hull with no crew aboard cannot act on a voyage row either. The runway
  // and gap checks already filter on inService; the schedule path did not.
  rows = rows.filter((r) => inService(r.ship, today));
  const act = actionable(rows);

  // THE 25 SHIPS WITH NO ORDERING SCHEDULE. Without this they appear nowhere in
  // this email, which reads to a printer exactly like "nothing is due for you".
  // [recOxbIZytNBd64AM] names that silence as the failure the whole system
  // exists to remove. A throw here must not take the email with it: a partial
  // email beats none, and beats one that quietly loses a section.
  // Every ship this run actually examined, so the header can say "X of Y ships
  // clear" about the real fleet rather than about whichever subset one query
  // happened to return.
  const checked = new Set(rows.map((r) => r.ship));

  let gaps = [];
  let deliveries = [];
  try {
    const g = await unscheduledGaps(env.HON, today);
    checks.push({ name: 'delivery gap', ran: Boolean(g.ran), reason: g.reason });
    if (g.ran) { gaps = g.findings; deliveries = g.deliveries || []; for (const sh of g.shipNames || []) checked.add(sh); }
    else await logIngest(env, 'cron', `schedule-free check did not run: ${g.reason}`);
  } catch (e) {
    const reason = String(e && e.message || e);
    checks.push({ name: 'delivery gap', ran: false, reason });
    await logIngest(env, 'cron', `schedule-free check threw: ${reason}`);
  }

  // WILL THEY RUN OUT BEFORE THE NEXT CONTAINER. The item-level half of the
  // objective's "this ship, this voyage, these exact items, this date".
  let runsOut = [];
  // `unread` WAS BUILT AND THEN DROPPED. fleetRunway has always returned the
  // items whose on_hand it could not read; this line took `findings` and
  // `shipNames` and left the rest on the floor, so an item we could not measure
  // produced no finding and its ship read CLEAR on it. It goes to coverage now.
  let unread = [];
  try {
    const r = await fleetRunway(env.HON, today);
    checks.push({ name: 'runway', ran: Boolean(r.ran), reason: r.reason });
    if (r.ran) { runsOut = r.findings; unread = r.unread || []; for (const sh of r.shipNames || []) checked.add(sh); }
    else await logIngest(env, 'cron', `runway check did not run: ${r.reason}`);
  } catch (e) {
    const reason = String(e && e.message || e);
    checks.push({ name: 'runway', ran: false, reason });
    await logIngest(env, 'cron', `runway check threw: ${reason}`);
  }

  // WHICH SHIPS HAVE NO ORDERING SCHEDULE WE CAN USE, AND WHY. Miguel, 16 Sep
  // 2026: "the email should say: you are missing this file, do it first." The
  // crew can fix this one themselves, so the email asks them, with the reason
  // the last attempt failed. A throw here loses a section, never the email.
  let schedules = [];
  let schedulesRan = false;
  let schedulesReason = null;
  try {
    const s = await scheduleStatuses(env.HON, env.FLEET_MAP, today);
    schedulesRan = Boolean(s.ran);
    schedulesReason = s.reason || null;
    checks.push({ name: 'ordering schedule', ran: schedulesRan, reason: schedulesReason });
    if (s.ran) { schedules = s.statuses; for (const st of s.statuses || []) if (st && st.ship) checked.add(st.ship); }
    else await logIngest(env, 'cron', `schedule status check did not run: ${s.reason}`);
  } catch (e) {
    const reason = String(e && e.message || e);
    checks.push({ name: 'ordering schedule', ran: false, reason });
    await logIngest(env, 'cron', `schedule status check threw: ${reason}`);
  }

  const checkedShips = [...checked];
  // WHAT THIS RUN COULD NOT DO. Never rendered to a crew - see coverage.js.
  const coverage = fleetCoverage({ fleetMap: env.FLEET_MAP, checked: checkedShips, checks, unread, today });
  return {
    rows, act, gaps, runsOut, deliveries, schedules, schedulesRan, schedulesReason, checked: checkedShips, coverage,
    html: renderWeekly(act, rows, today, { gaps, runsOut, deliveries, schedules, checked: checkedShips, coverage }),
  };
}

// ingest_log IS SHARED with cims-hon, whose own obp@cims.work route writes rows
// that look exactly like ours once source said 'email' for both. It did, and the
// result was that this Worker could not tell "no mail has ever reached me" from
// "forty mails arrived, none of them mine" - the difference between a missing
// Cloudflare route and a broken parser. Tag our own rows. See watchdog check 9.
async function logIngest(env, sender, note) {
  try {
    await env.HON.prepare(
      `INSERT INTO ingest_log (source, sender, note, ts) VALUES (?, ?, ?, datetime('now'))`
    ).bind(INGEST_SOURCE, sender || 'unknown', note).run();
  } catch (_) { /* logging must never block the ingest */ }
}

// A DELIVERED MAIL MUST NEVER LEAVE NO TRACE. Every path below ends in a
// logIngest call - but only if it reaches one. htmlPartOf, attachmentsOf and
// parseAzamaraRows all run BEFORE the first log line and none of them is total.
// One throw and a mail Cloudflare accepted disappears with no row, no bounce
// and no error anyone reads, which is indistinguishable from the route not
// existing. That ambiguity is exactly what cost two days on 10 Sep.
async function ingestEmail(message, env) {
    const subject = message.headers.get('subject') || '';

    let raw = '';
    try {
      raw = new TextDecoder().decode(await readAll(message.raw));
    } catch (e) {
      // Not "best effort": an unread mail logged as a bad parse blames the
      // sender for our failure. Say what happened and bounce it back.
      await logIngest(env, message.from, `raw could not be read: ${String((e && e.message) || e).slice(0, 200)} - subject "${subject.slice(0, 90)}"`);
      throw e;
    }

    // DECODE BEFORE PARSING. Outlook sends quoted-printable or base64; handing
    // raw MIME to the HTML parser drops rows and writes nulls. See lib/mime.js.
    const body = htmlPartOf(raw) || raw;

    // Attachment names are part of the identity test. Ray was asked to attach
    // the MLS as well as pasting it, and a mail whose subject drifted may still
    // be identifiable by its filename.
    const attachments = attachmentsOf(raw);
    const names = attachments.map((a) => a.filename).join(' ');

    // THE OBP CSV EXPORTS. obp-csv@cims.work routes here. The three files are
    // written from the OBP database every night and their names are the
    // identity test; the workbook mirror that cims-hon ingests is only a cache
    // of them and stalls (see obpSource.js). Written to this Worker's own
    // weekly_obp_* tables; the obp_* mirror is never touched.
    if (isObpCsvMail(names, subject)) {
      const r = await ingestObpCsv(env.HON, attachments, iso(new Date()));
      await logIngest(env, message.from,
        `OBP CSV: inventory ${r.inventory} rows` +
        (r.inventory_ships ? ` / ${r.inventory_ships} ships, newest UpdateDate ${r.inventory_newest_update}` : '') +
        `, intransit ${r.intransit} rows` +
        (r.refused.length ? ` | REFUSED: ${r.refused.join('; ')}` : '') +
        ` | files: ${r.seen.join(', ')}`);
      return;
    }

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
    let rows = parseAzamaraRows(rowsFromHtml(body));

    // THE WORKBOOK PATH. The table is usually pasted; when it is only attached,
    // read the attachment. Body rows win when both exist (they carry colour).
    const workbooks = attachments.filter((a) => /\.xlsx?$/i.test(a.filename));
    let parsedFrom = rows.length ? 'body' : null;
    if (!rows.length) {
      for (const w of workbooks) {
        try {
          const wrows = parseAzamaraRows(rowsFromWorkbook(XLSX.read, XLSX.utils, w.bytes));
          if (wrows.length) { rows = wrows; parsedFrom = w.filename; break; }
        } catch (e) {
          await logIngest(env, message.from, `workbook ${w.filename} could not be read: ${String(e && e.message || e)}`);
        }
      }
    }

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
          ? ` ${workbooks.length} workbook attachment(s) read (${workbooks.map((w) => w.filename).join(', ')}) ` +
            `and none carried a row with SHIP + DELIVERY DATE TO BWS headers.`
          : ''));
      return;
    }

    const notes = notesFromBody(body.replace(/<[^>]+>/g, ' '));
    const r = await saveAzamara(env.HON, usable, 'azamara-mls');
    await logIngest(env, message.from,
      `Azamara MLS (from ${parsedFrom}): ${r.written} rows, ${r.missing} with no PO` +
      (notes.length ? ` | notes: ${notes.join(' // ')}` : ''));
}

export default {
  // ---- Ray's Azamara MLS lands here ----
  //
  // Log the throw, then RETHROW. Rethrowing makes Cloudflare treat the message
  // as failed, which bounces it to the sender. A bounce is loud and lands with
  // the one person who can resend it. Swallowing would be quieter and would
  // lose Ray's file.
  async email(message, env) {
    try {
      await ingestEmail(message, env);
    } catch (e) {
      await logIngest(env, message.from,
        `email handler THREW, message NOT ingested: ${String((e && e.stack) || e).slice(0, 400)}`);
      throw e;
    }
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
    // The day the CRON says it is, not the day the code happens to run. Same
    // calendar day in production; in a test it is what makes the run reproducible.
    const today = iso(new Date(event.scheduledTime || Date.now()));

    if (event.cron === REQUEST_CRON) {
      await runSendRequests(env, today);
      return;
    }

    if (event.cron === MONTHLY_CHASE_CRON) {
      // QUEUE ONLY. The 15-minute runner sends it, so this branch never races
      // that runner (they can share a minute) and the record is the queue row.
      try {
        await ensureSendRequestTable(env.HON);
        const r = await env.HON.prepare(
          `INSERT INTO weekly_send_request (ship, kind, note) VALUES ('*', 'chase', ?1)`)
          .bind(`monthly chase, 2nd of the month, ${today}`).run();
        const id = r && r.meta && r.meta.last_row_id;
        await logIngest(env, 'cron', `monthly chase ${today}: queued row #${id || '?'} for every ship missing its Ordering Schedule; the 15-minute runner sends it`);
      } catch (e) {
        await logIngest(env, 'cron', `monthly chase ${today} threw: ${String((e && e.message) || e)}`);
      }
      return;
    }

    if (event.cron === NIGHTLY_CRON) {
      const report = await runWatchdog(env, today, { repair: true });
      // "ADMIN_KEY set/unset" is presence only, never the value. A session
      // cannot reach this Worker's HTTP surface, so this line is the only way
      // to see from D1 whether the secret exists (asked 16 Sep 2026).
      await logIngest(env, 'watchdog',
        (report.healthy
          ? 'night check clean'
          : `night check: ${report.counts.critical} critical, ${report.counts.warn} warn, ${report.repairs.length} repaired`) +
        ` | ADMIN_KEY ${env.ADMIN_KEY ? 'set' : 'unset'}`);
      if (report.healthy) return; // silence means healthy

      // The night check is an ENGINEERING digest - stale feeds, format drift,
      // rows repaired. Ray does not need it and must not get it: he is the
      // person the fleet email is signed by, and ops noise in his inbox is how
      // a useful alert becomes something he filters. WATCHDOG_TO is Miguel only.
      //
      // AND IT REMEMBERS WHAT IT SAID. Miguel emptied WATCHDOG_TO on 10 Sep
      // 2026 because a stateless check would repeat a standing finding every
      // night until it was filtered. Now a finding is mailed the night it
      // first appears, then goes quiet; a critical one that is still standing
      // a week later is mentioned again, once a week. The feed freeze of 10-16
      // Sep was detected on night one and told nobody - that is the failure
      // this closes.
      const memory = await rememberFindings(env.HON, report, today);
      const to = (env.WATCHDOG_TO || '').split(',').map((x) => x.trim()).filter(Boolean);
      if (!to.length) {
        await logIngest(env, 'watchdog', 'WATCHDOG_TO is empty. Findings logged, nothing sent.');
        return;
      }
      if (!memory.fresh.length && !memory.reminders.length) {
        await logIngest(env, 'watchdog',
          `night check: nothing new since last night (${report.findings.length} standing), nothing sent`);
        return;
      }
      ctx.waitUntil((async () => {
        const newCrit = memory.fresh.filter((f) => f.severity === 'critical').length;
        const subject = memory.fresh.length
          ? `Night check - ${memory.fresh.length} new${newCrit ? `, ${newCrit} need${newCrit === 1 ? 's' : ''} a human` : ''}`
          : `Night check - ${memory.reminders.length} still standing after a week`;
        try {
          const r = await send(env, to, subject,
            renderWatchdog({ ...report, fresh: memory.fresh, reminders: memory.reminders }), 'orders-watchdog-night',
            [], null, `night:${today}`);
          if (!r.sent) await logIngest(env, 'watchdog', `digest send FAILED: ${JSON.stringify(r)}`);
          // Only a digest that went out counts as "said": a finding whose
          // mail failed is offered again tomorrow (review, 18 Sep 2026).
          else await markMailed(env.HON, [...memory.fresh, ...memory.reminders], today);
        } catch (e) {
          await logIngest(env, 'watchdog', `digest send THREW: ${String((e && e.message) || e)}`);
        }
      })());
      return;
    }

    // ONLY THE MONDAY CRON MAILS THE FLEET. Anything else that reaches here is
    // a trigger nobody wired a handler for, and it is logged, not mailed.
    if (event.cron !== WEEKLY_CRON) {
      await logIngest(env, 'cron', `unhandled cron "${event.cron}" - nothing run`);
      return;
    }

    // DESTRUCTURE EVERYTHING THE LINES BELOW READ. This said
    // `{ rows, act, html }` while the log line and the early return both read
    // `gaps` and `runsOut` - two bindings that did not exist in this scope.
    // Under ESM that is a ReferenceError, so the ENTIRE Monday run threw before
    // a single address was resolved, and the failure looked exactly like the
    // cron not firing. Caught only by running the scheduled handler itself,
    // which is why test/scheduled.test.mjs now does.
    const { rows, act, gaps, runsOut, deliveries, schedules, html, coverage } = await buildWeekly(env, today);
    // Ships that must be asked for their Ordering Schedule. A finding in its
    // own right: a ship we cannot check is a ship that can miss a container.
    const ask = needsSchedule(schedules);

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
      (gaps.length ? `, ${gaps.length} delivery gaps on ships with no schedule` : '') +
      (ask.length ? `, ${ask.length} ships asked for their ordering schedule` : '') +
      (faults.length ? `, ${faults.length} unusable rows (engineering)` : '') +
      // WHAT THE RUN COULD NOT DO GOES IN THE SAME LINE the watchdog already
      // reads. A run that examined 45 of 48 ships must not log like a run that
      // examined all 48 and found them well.
      (coverage && coverage.ok
        ? `, all ${coverage.addressed} addressed ships examined`
        : `, COULD NOT CHECK: ${(coverage && coverage.note) || 'coverage unknown'}`));

    // NOTHING DUE **AND** NO GAPS. I broke this an hour after building the
    // fallback: the early return tested act.length alone, so on a week like
    // this one - 0 actionable, 15 delivery gaps across the 25 ships with no
    // schedule - the run ended here and not one of those ships heard anything.
    // The schedule-free check was dead on arrival, restoring the exact silence
    // it was written to remove.
    // NOTHING FOUND IS ONLY GOOD NEWS IF EVERYTHING WAS LOOKED AT. When a check
    // dies, its findings array is empty, and every test above passes - so the
    // worst run this Worker can have (nothing examined, nothing known) used to
    // take the same quiet exit as its best. Coverage decides now: a degraded
    // run always reaches onboardsupport, even with zero findings.
    if (!act.length && !gaps.length && !runsOut.length && !ask.length && (!coverage || coverage.ok)) {
      return; // genuinely nothing to say, and we looked at everything
    }

    const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);
    const supervisors = list(env.DRY_RUN_TO);
    // ONE COUNT FOR EVERY SUBJECT LINE. The dry run was fixed to count
    // stockouts and gaps; the live fleet-list subject still read act.length
    // alone, so a live Monday with 0 voyages and 39 stockouts would have gone
    // to onboardsupport as "0 to fix". Computed once, used everywhere.
    const todo = act.length + gaps.length + runsOut.length + ask.length;
    // Miguel, 15 Sep 2026: the whole-fleet email goes to onboardsupport; each
    // ship's email goes to the ship with Ray in copy. Every address here was
    // typed by a human into wrangler.toml; nothing is derived.
    const fleetTo = list(env.FLEET_TO);
    const shipCc = list(env.SHIP_CC);
    const replyTo = list(env.REPLY_TO)[0] || null;

    // ---- DRY RUN: the whole fleet list, to Miguel and Ray only ----
    if (env.SEND_TO_FLEET !== 'true') {
      if (!supervisors.length) {
        await logIngest(env, 'cron', 'DRY_RUN_TO is empty. Nothing sent.');
        return;
      }
      ctx.waitUntil((async () => {
        // THE SUBJECT LINE IS THE ONLY PART MOST PEOPLE READ. Counting
        // act.length alone printed "0 to fix" on a week carrying 39 stockouts
        // and 3 gaps - the email arguing against itself in the inbox list.
        try {
          const r = await send(env, supervisors, `Orders due this week - ${todo} to fix`, html, 'orders-due-weekly', [], replyTo, `weekly:${today}:dryrun`);
          if (!r.sent) await logIngest(env, 'cron', `weekly send FAILED: ${JSON.stringify(r)}`);
        } catch (e) {
          await logIngest(env, 'cron', `weekly send THREW: ${String((e && e.message) || e)}`);
        }
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
    // ONCE PER MONDAY. A re-delivered or re-fired cron must not mail 48 ships
    // twice; the "weekly fleet send" line is written only after a live run.
    // A run that mailed NOBODY (mailer down) does not count, so the same-day
    // retry can go out; the idempotency keys keep the partial case safe.
    try {
      const done = await env.HON.prepare(
        `SELECT 1 x FROM ingest_log WHERE source = ?1 AND sender = 'cron' AND note LIKE 'weekly fleet send:%'
            AND note NOT LIKE 'weekly fleet send: 0 of %' AND ts >= ?2 LIMIT 1`)
        .bind(INGEST_SOURCE, today).first();
      if (done && done.x) {
        await logIngest(env, 'cron', `weekly fleet send already done today (${today}); this invocation sends nothing`);
        return;
      }
    } catch (_) { /* no read = no evidence of a send; the idempotency key is the second guard */ }
    const plan = planFleetSend(act, env.FLEET_MAP, gaps, runsOut, schedules);
    if (!plan.sendable.length) {
      await logIngest(env, 'cron',
        `SEND_TO_FLEET is true but NONE of the ${plan.unmapped.length} ships due this week ` +
        `has an address in FLEET_MAP (${plan.mapped_ships} ships mapped in total). ` +
        `Nothing sent to the fleet.`);
    }
    ctx.waitUntil((async () => {
      let sent = 0;
      let deduped = 0;
      const failed = [];
      // EVERY SEND IS ISOLATED. send() awaits a fetch on the MAILER binding, and
      // a fetch REJECTS on a transport error rather than returning a status. One
      // such rejection used to abort this loop, so ship 12 failing meant ships
      // 13 to 48 were never mailed, no failure was logged, and the supervisor
      // digest below never ran either - a silent partial send, which is the one
      // outcome worse than not sending at all.
      for (const group of plan.sendable) {
        // The subject must name what is actually inside. "a gap in your
        // deliveries" went out for every ship with no due date, including one
        // carrying eleven stockouts and no gap at all.
        const subject = shipSubject(group.ship, { rows: group.rows, runsOut, gaps, ask });
        try {
          const r = await send(
            env,
            group.to,
            `${group.ship}: ${subject}`,
            renderWeekly(group.rows, rows, today, { audience: 'ship', ship: group.ship, gaps, runsOut, deliveries, schedules }),
            'orders-due-weekly',
            shipCc,
            replyTo,
            `weekly:${today}:${normShip(group.ship)}`
          );
          if (r.sent) { sent++; if (r.dedup) deduped++; }
          else failed.push(`${group.ship} -> ${group.to.join(',')}: ${JSON.stringify(r)}`);
        } catch (e) {
          failed.push(`${group.ship} -> ${group.to.join(',')}: threw ${String((e && e.message) || e)}`);
        }
      }
      // One line per run, not one per ship: the log is evidence, not a feed.
      await logIngest(env, 'cron',
        `weekly fleet send: ${sent} of ${plan.sendable.length} ships mailed` +
        (deduped ? ` (${deduped} already sent today by an earlier run, not re-sent)` : '') +
        (plan.unmapped.length ? `, ${plan.unmapped.length} unaddressable` : '') +
        (plan.malformed.length ? `, ${plan.malformed.length} malformed FLEET_MAP entries` : ''));
      for (const f of failed) await logIngest(env, 'cron', `weekly send FAILED: ${f}`);

      // The whole-fleet list, live: to FLEET_TO (onboardsupport). If that is
      // empty it falls back to the dry-run supervisors rather than to nobody,
      // because the ships nobody could reach are named only in this email.
      const digestTo = fleetTo.length ? fleetTo : supervisors;
      if (!digestTo.length) await logIngest(env, 'cron', 'FLEET_TO and DRY_RUN_TO are both empty. Fleet list not sent.');
      if (digestTo.length) {
        // Keyed on SHIPS, not voyage rows: a ship whose only finding is a
        // stockout, a gap or a schedule ask has no rows and was going unnamed.
        const unreachable = plan.unmapped;
        try {
          const r = await send(env, digestTo,
            `Orders due this week - ${todo} to fix, ${sent} of ${plan.sendable.length} ships mailed` +
            (unreachable.length ? `, ${plan.unmapped.length} unaddressable` : ''),
            html, 'orders-due-weekly', [], replyTo, `weekly:${today}:fleet`);
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

    // EVERY OPERATIONAL ENDPOINT IS NOW BEHIND ADMIN_KEY.
    //
    // These were public, and that was documented as a decision left untaken
    // because locking them down changes behaviour something may depend on. On
    // 10 Sep the calculus changed inside an hour: azamara@cims.work now routes
    // fleet mail to this Worker, and Workers Builds publishes a preview URL for
    // every commit. /states, /misses and /azamara return the fleet's ordering
    // position, ship by ship, to anyone holding one of those URLs. That is a
    // competitor's view of another company's supply chain.
    //
    // FAIL CLOSED. With no ADMIN_KEY set, these refuse rather than serve. An
    // access control that quietly disables itself when unconfigured is not one.
    // The crons do not come through fetch(), so the Monday email and the night
    // check are unaffected either way.
    const PUBLIC = new Set(['/health', '/']);
    if (!PUBLIC.has(url.pathname)) {
      if (!env.ADMIN_KEY) {
        return json({
          error: 'ADMIN_KEY is not set',
          detail: 'This endpoint returns fleet operational data and refuses to serve it ' +
            'unauthenticated. Set ADMIN_KEY as a Worker secret, then pass ?key=<ADMIN_KEY>.',
        }, 503);
      }
      // Header OR query. A browser can only do the query form, which is what
      // Miguel needs, but a query string lands in browser history and in every
      // access log that records a URL. Anything scripted should send the header
      // instead - the same shape cims-hon already uses for x-ingest-token.
      const given = request.headers.get('x-admin-key') || url.searchParams.get('key');
      if (!secretEquals(given, env.ADMIN_KEY)) {
        return json({ error: 'unauthorized', detail: 'pass ?key=<ADMIN_KEY>' }, 401);
      }
    }

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
        // THE ROW COUNT ABOVE IS NOT PROOF THE INGEST WORKS. On 10 Sep 2026 it
        // read 14 while not one MLS had ever reached this Worker - those rows
        // came in by another path and nothing could refresh them. The mail route
        // is a separate fact and has to be shown as one.
        mail_received: (await q(
          `SELECT COUNT(*) n FROM ingest_log
            WHERE source = '${INGEST_SOURCE}' AND sender NOT IN ('cron', 'watchdog')`)).n,
        // SCOPED, LIKE ITS TWIN IN watchdog.js. This was the one ingest_log
        // read left unscoped when PR #26 fixed the other six, so /health and
        // the night check could disagree about the last MLS the moment another
        // app on this shared table logged a matching note.
        last_azamara_mls: (await q(
          `SELECT MAX(ts) d FROM ingest_log
            WHERE source = '${INGEST_SOURCE}'
              AND note LIKE 'Azamara MLS%' AND note NOT LIKE '% REFUSED:%'`)).d,
        intransit_snapshot: (await q('SELECT MAX(snapshot_date) d FROM obp_intransit')).d,
        // WHICH COPY OF OBP THE READERS USE. 'mirror' is the emailed workbook
        // via cims-hon; 'csv' is this Worker's own copy of the nightly exports
        // (obp-csv@cims.work). The CSV date going stale while the mirror moves
        // means the flow stopped attaching the files.
        obp_source: await obpSource(env.HON).then((s) => ({
          inventory: s.inventory.source, intransit: s.intransit.source,
          csv_snapshot: s.csv.inventory, mirror_snapshot: s.mirror.inventory,
        })).catch(() => null),
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
      // THE SAME PLAN THE MONDAY RUN USES. This planned from voyage rows alone,
      // so a stockout-only ship (Quest, 11 items on 12 Sep) was absent from
      // would_send here and mailed on Monday anyway.
      const { act, gaps, runsOut, schedules } = await buildWeekly(env, today);
      const plan = planFleetSend(act, env.FLEET_MAP, gaps, runsOut, schedules);
      const dryFor = (ship) => runsOut.filter((f) => normShip(f.ship) === normShip(ship)).length;
      const gapsFor = (ship) => gaps.filter((g) => normShip(g.ship) === normShip(ship)).length;
      const schedFor = (ship) => (schedules.find((s) => normShip(s.ship) === normShip(ship)) || {}).status || null;
      const unlocked = Boolean(env.ADMIN_KEY) && secretEquals(
        request.headers.get('x-admin-key') || url.searchParams.get('key'), env.ADMIN_KEY);
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
          running_out: dryFor(g.ship), gaps: gapsFor(g.ship), schedule: schedFor(g.ship),
          due: g.rows.map((r) => `${r.due_date} ${r.state}`),
        })),
        // The half that matters most: due this week and unreachable.
        unaddressable: plan.unmapped.map((g) => ({
          ship: g.ship, orders: g.rows.length,
          running_out: dryFor(g.ship), gaps: gapsFor(g.ship), schedule: schedFor(g.ship),
          due: g.rows.map((r) => `${r.due_date} ${r.state}`),
        })),
      });
    }

    // A ship's own email, exactly as that ship would receive it. ?ship=Apex
    if (url.pathname === '/preview-ship') {
      const want = url.searchParams.get('ship') || '';
      // EXACTLY WHAT MONDAY BUILDS. This planned without the stockouts, so a
      // stockout-only ship answered 404 "nothing due" here and was mailed on
      // Monday - the preview lying about the send it previews.
      const { rows: st, act, gaps: gp, runsOut: ro, deliveries: gd, schedules: sc } = await buildWeekly(env, today);
      const plan = planFleetSend(act, env.FLEET_MAP, gp, ro, sc);
      const g = [...plan.sendable, ...plan.unmapped]
        .find((x) => x.ship.toLowerCase().includes(want.toLowerCase()));
      if (!want || !g) {
        return json({
          error: want ? `no ship matching "${want}" has anything due this week` : 'pass ?ship=',
          available: [...plan.sendable, ...plan.unmapped].map((x) => x.ship),
        }, 404);
      }
      return new Response(
        renderWeekly(g.rows, st, today, { audience: 'ship', ship: g.ship, gaps: gp, runsOut: ro, deliveries: gd, schedules: sc }),
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
