# cims-hon — inbound mail must never be refused

**Spec for a cims-hon session. Written 20 Sep 2026 by the weekly_orders_email session.
Read §1 and §7 before writing any code. Nothing here was implemented — this repo was
read only.**

---

## 1. The diagnosis, and the fix that was already tried

Two messages to `obp@cims.work` were refused with `421 4.3.0 Upstream error`
(17 Sep 18:10 UTC and 20 Sep evening — different relay hosts, different Cloudflare
IPs, different queue IDs, so two distinct messages). A 421 is a **temporary** SMTP
refusal; the sending relay retries for 48 hours and then **destroys the message**.
Both are gone. No record of either exists anywhere in cims-hon.

### The obvious fix is already in the code and has never fired

`src/worker.js:232` already wraps the entire `email()` body in try/catch and logs
`ERROR ${e.message}`. Measured in D1 on 20 Sep:

```sql
SELECT COUNT(*) AS total,
       SUM(CASE WHEN note LIKE 'ERROR%' THEN 1 ELSE 0 END) AS errors
FROM ingest_log WHERE source='email';
-- total 230, errors 0   (since 2026-08-23)
```

**230 inbound messages, zero caught exceptions.** The handler has never thrown and
been caught. So "wrap it in try/catch" is not the fix — it is already there, and it
did not prevent either bounce.

### Why try/catch cannot be the fix

A Worker that exceeds its **CPU or memory allocation is terminated, not thrown**.
There is no exception to catch. Email Routing gets no response from the Worker and
returns `421 Upstream error`. **Zero `ERROR` rows across 230 messages is the
fingerprint of a handler being killed rather than failing.**

This project has already been bitten by exactly this. `src/lib/xlsxIngest.js:7`:

> *"CPU discipline: the engine is NOT run here. Parsing a 16.8k-row workbook and
> writing ~22k rows is already most of an invocation's budget; running the 51-ship
> engine in the same call is what blew the CPU allocation (**email delivery failed**;
> HTTP ingest computed only 20/51)."*

Moving the engine out (2026-08-27) reduced the cost. It did not change the shape of
the problem: `routeAttachment` still parses every workbook and writes thousands of
rows **inline, inside the email handler, while the SMTP transaction is held open**.

### The actual defect

> **Accepting a message and processing a message share one failure domain.**

Anything that goes wrong while processing — CPU limit, memory, a slow D1, a hang —
takes the *delivery* down with it. The message is refused, retried for 48 hours,
and destroyed. We lose the data and there is no record that it ever existed.

**Honest limit:** this does not prove what killed Ray's 17 Sep message specifically
— it was 3,350 bytes with no attachment, a trivial path, and may have been
transient. The fix below makes the whole class impossible regardless of which cause
fired. Do not treat "CPU" as established for that one message.

---

## 2. The rule

**The email handler's only job is to make the bytes durable and say yes.**

Everything else — parsing, routing, ingesting, running the engine, replying — is a
separate job with a separate budget, and it is allowed to fail. Accepting mail is
not.

---

## 3. The new `email()` handler contract

Replace the body of `async email(message, env, ctx)` with exactly four steps. No
parsing, no PostalMime, no D1 reads, no attachment logic.

1. **Read the raw bytes.**
   `const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());`

2. **Store them, content-addressed, and verify.**
   Use the existing `putScan()` from `src/lib/storeFile.js` — it already does
   put-then-HEAD, which is the difference between "we asked R2 to keep it" and
   "R2 has it". Key it by content hash with the existing `sha256Hex()`:

   ```
   inbox/<YYYY-MM-DD>/<sha256hex>.eml      contentType: message/rfc822
   ```

   Content addressing is not decoration. A relay retry delivers **identical bytes**,
   so it produces an identical key and R2's put is idempotent. A duplicate delivery
   cannot create a duplicate ingest. This is the same reasoning already written into
   `contentKey()` for scans.

3. **Write one claim row** (schema in §4) and one `ingest_log` receipt row.

4. **Return.**

Target: a few milliseconds and a bounded number of subrequests, **identical for a
3 KB empty message and a 16,000-row workbook**. That invariant is the whole fix.

### The one place failure is still allowed — and required

**If `putScan()` returns `ok:false`, throw.**

This is deliberate and it is not a hole in the design. If the bytes are not
durable, a 421 is the *correct* answer: the relay holds the message and retries for
48 hours, and nothing is lost. Accepting a message we could not store would be
worse than refusing it — it would be the silent data loss this whole exercise
exists to end.

The rule is not "never fail". It is **"fail only where failing is safe."**

---

## 4. Storage and state

### New D1 table

```sql
CREATE TABLE inbox (
  key         TEXT PRIMARY KEY,          -- the R2 key; content hash makes it the dedupe
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  sender      TEXT,
  size        INTEGER,
  state       TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | failed
  attempts    INTEGER NOT NULL DEFAULT 0,
  claimed_at  TEXT,
  note        TEXT
);
CREATE INDEX inbox_state ON inbox (state, received_at);
```

Insert with `INSERT OR IGNORE` — a retried delivery hits the same primary key and
is silently ignored, which is exactly right.

### R2 lifecycle

Keep `inbox/` objects **90 days**, then expire. They are raw emails: small, bounded
by the mail that actually arrives, and they are the evidence. The existing
`unparsed/` parking convention stays as it is for attachments the router cannot
place — this is a layer above it.

---

## 5. The processor

A new cron, running **every 5 minutes**. Ships send schedules and expect same-day
handling; the existing 06:30/18:30 watchdog cadence is far too slow to be the mail
path.

```toml
crons = ["30 6 * * *", "30 18 * * *", "*/5 * * * *"]
```

Match the new expression **explicitly** in `scheduled()` (`event.cron === "*/5 * * * *"`)
so it never runs the watchdog and the watchdog never runs it.

Per invocation:

1. **Claim atomically.** `UPDATE inbox SET state='claimed', claimed_at=datetime('now'),
   attempts=attempts+1 WHERE key=?1 AND state='pending'` — check `meta.changes === 1`
   before doing any work. Two overlapping crons must never process one message twice.
2. **Bound the batch. Process at most 3 messages per invocation.** This is the CPU
   discipline, restated where it now belongs: the budget problem does not disappear,
   it moves somewhere a failure is survivable. At 3 per 5 minutes the queue drains
   36 messages an hour, well above the real arrival rate (230 in four weeks).
3. **Fetch from R2, parse, and route through the existing path.** `PostalMime.parse`,
   the trusted-sender test, the BACKFILL subject logic and the `routeAttachment`
   loop all move here **unchanged**. Do not write a second parse path — the repo
   already learned that lesson for the `unparsed/` re-feed
   (`src/worker.js:339`: *"A second parse path here would be a second definition of
   'what to do with this file' and would drift from the one the mail uses."*).
4. **Write the `ingest_log` row in the existing format** (see §7 — this is load-bearing).
5. **Mark `done`**, or on a throw leave a note and return to `pending`.
6. **Give up after 3 attempts:** `state='failed'`, and alert `WATCH_ALERT_TO`. A
   message that cannot be processed is now a visible row with the bytes still in
   R2 — diagnosable, and re-feedable through the existing endpoint.

### Stuck-claim recovery

A claim whose invocation died leaves `state='claimed'` forever. Each run first
resets anything `claimed` older than 15 minutes back to `pending`. Without this,
one killed invocation silently parks a message for good — the same silent-loss
pattern in a new place.

---

## 6. The reply to the sender

Ray's 17 Sep message **had no attachment**. Everything above would have accepted it,
stored it, logged it — and Solstice would *still* have no schedule, with Ray
believing he had sent one. Durability alone does not close the loop. **The sender
has to be told.**

After processing, reply via the existing `MAILER` service binding (`cims-mailer`,
already bound in `wrangler.toml`), using the standard envelope
`{ app, templateId, idempotencyKey, from, to, cc, subject, html, text, critical }`
and the `cims-email-standard` letterhead.

Three rules:

- **Only to trusted senders.** Reuse the existing `trusted` regex. Never reply to an
  untrusted sender — that turns the ingest address into a spam reflector.
- **`idempotencyKey` = the R2 content key.** cims-mailer already dedupes on it, so a
  reprocessed message cannot mail the ship twice.
- **One reply per message**, whatever the outcome.

Two outcomes, in crew English — short, no jargon, no instructions the reader has to
decode:

- **Read it:** *"Got your Silhouette Ordering Schedule — 60 orders read, 14 coming up.
  Nothing else needed."*
- **Could not:** *"We got your email but there was no Excel file attached. Please send
  the Ordering Schedule as an .xlsx or .xls file — not a photo, not a PDF."*
  (Same shape for: not a spreadsheet, parsed zero rows, filename maps to no ship.)

The "could not" reply is the one that pays for this section. It is the only thing in
the whole system that tells a crew member their file did not land.

---

## 7. What must NOT change — cross-app contract

**Read this before touching `ingest_log`.**

`weekly_orders_email` judges which ships are missing an Ordering Schedule by reading
cims-hon's `ingest_log` directly, in `src/lib/scheduleStatus.js`:

```sql
SELECT sender, ts, note FROM ingest_log
 WHERE source IN ('email', 'reingest')
   AND (lower(note) LIKE '%schedule%' OR note LIKE 'no spreadsheet attachment%')
   ...
```

It also parses the ship out of the note text with `/→\s*([^(:→]+?)\s*\(via\b/`.

That app drives the Monday fleet email to 48 ships and the monthly compliance chase.
**If the meaning or wording of `source='email'` rows changes, it silently
mis-judges the fleet** — ships that sent their file get chased, ships that did not
go quiet. There is no test in cims-hon that would catch this.

So:

- The **receipt** row written by the handler must use a **new source value**:
  `source='email-received'`. It is invisible to the query above, which is the point.
- The **processor** keeps writing `source='email'` rows with the **existing note
  formats, byte for byte** — `"N spreadsheet(s) — <file> → <Ship> (via filename): …"`,
  `"no spreadsheet attachment; …"`, `"rejected sender (not trusted); …"`. Do not
  reword them, do not add a prefix, do not change the arrow or the `(via …)` shape.
- `ts` on the `source='email'` row is now **processing** time, not arrival time —
  up to 5 minutes later. Harmless for that app (it works in whole days), but it is a
  real semantic change and belongs in the commit message.

If a reword is genuinely wanted later, it is a coordinated change across both repos,
not a cims-hon change.

---

## 8. Verification — by execution, not by reading

Do not ship on the strength of the code looking right. Prove each line:

1. **Empty message.** Send a 3 KB message with no attachment. Expect: `inbox` row
   `done`, an `email-received` row, an `email` row reading `no spreadsheet
   attachment; 0 attachments`, and a "no Excel file attached" reply at the sender.
2. **The biggest workbook you have.** Send the 16.8k-row OBP export. Expect: handler
   returns in milliseconds, delivery accepted, processed on the next cron tick.
   **This is the case that used to kill the invocation** — it is the whole test.
3. **Duplicate delivery.** Send byte-identical content twice. Expect: one R2 object,
   one `inbox` row, one ingest, **one** reply.
4. **Storage failure.** Temporarily unbind `SCANS` in a preview and confirm the
   handler throws and the message is refused rather than accepted-and-lost. This
   verifies §3's deliberate failure path.
5. **Concurrency.** Two cron invocations overlapping must not double-process. Assert
   `meta.changes === 1` on the claim.
6. **The cross-app check.** After deploying, run `weekly_orders_email`'s schedule
   judgement and confirm the missing-ships list is **unchanged** from before. This is
   the §7 regression test and it lives outside this repo.

---

## 9. Residual risks, stated plainly

- **A cims-hon outage still refuses mail.** If the Worker cannot run at all (bad
  deploy, platform incident), Email Routing still returns 421. The relay retries for
  48 hours, so anything shorter than that self-heals. An outage over 48 hours is not
  worth engineering against here.
- **Message size.** Cloudflare Email Routing caps inbound messages (~25 MB) at the
  edge, before the Worker. This fix cannot change that; a very large workbook is
  refused upstream and we would still never see it. Worth confirming the real cap
  against Cloudflare's current docs rather than trusting this number.
- **The reply depends on cims-mailer.** If cims-mailer is down the message is still
  ingested — the reply is best-effort and must never fail the processing step or
  revert the claim.
- **This does not retrieve the two lost messages.** They are gone. Solstice still
  needs its Ordering Schedule sent again.

---

## 10. Order of work

1. §3 + §4 — handler and storage. **This alone ends the refusals.** Ship it first,
   verify with test 2, and the bleeding stops.
2. §5 — the processor.
3. §6 — the replies. Highest crew-facing value, lowest risk, and independent of the
   first two.

§7 applies to every one of them.
