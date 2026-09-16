# weekly_orders_email

Cloudflare Worker with three jobs:

1. **Catches Ray's Azamara MLS** — including when he pastes the table into the email body
   instead of attaching a file, which is what the current `cims-hon` ingest misses entirely.
2. **Sends the weekly orders email** every Monday 08:00 Miami time — the ships whose order
   due date falls in the next 7 days with nothing raised against it, one email per ship.
3. **Runs a night check** at 02:00 Miami — feeds, format drift, duplicate rows, expired
   schedules, incomplete orders and inventory anomalies. It mails only when it finds something.

The purpose is narrow: stop paying emergency shipping because a printer forgot to raise an order.

---

## What Miguel has to do

One thing left, and two done on 16 Sep 2026:

1. **Set `ADMIN_KEY` as a Worker secret.** Until it is set every endpoint except `/health`
   returns 503, so nobody can see `/fleet` (who will be mailed) or `/preview-ship` before a
   Monday. Still unset on 16 Sep (`/fleet` answered `ADMIN_KEY is not set`).
2. ~~Route `obp-csv@cims.work` to this Worker~~ **Done 16 Sep**: Cloudflare Email Routing,
   zone `cims.work`, `obp-csv@cims.work` → Worker `weekly-orders-email`, Active.
   `obp@cims.work` still belongs to `cims-hon` and was not touched.
3. ~~Edit the Power Automate flow~~ **Done 16 Sep**: the flow is named **"HON — nightly OBP"**
   in Miguel's *My flows* ("OBP nightly" is only the subject of the email it sends). After
   its unchanged workbook email it now runs three *Get file content* steps for the Exports
   CSVs and a second *Send an email (V2)* to `obp-csv@cims.work`, subject "OBP nightly CSV".
   The first run landed here at 18:25Z as `ingest_log` 280: 3481 inventory rows for 50
   ships, 1962 in-transit rows for 48.

Then **verify, do not assume**: `GET /health` shows `obp_source.csv_snapshot` with today's date
every morning, and `mail_received` counts every mail that reached *this* Worker.

There is **no mail secret to add.** Sending goes through the `MAILER` service binding to
`cims-mailer`, which holds the only Resend key in the estate and reads no `Authorization`
header. **There is no `MAILER_URL` and no `MAILER_TOKEN`.** An earlier version of this file
told you to create both; the code then invented a URL-and-token interface that does not
exist, and a Resend key ended up pasted into a plaintext Worker variable. Do not add them back.

The D1 bindings (`HON`, `ORDERS`, and `MAIL` read-only) and both crons are in `wrangler.toml`.

### The Azamara route exists and works

`azamara@cims.work` routes here. Ray's MLS of 11 Sep 2026 reached this Worker and was
**refused** — 0 rows parsed from the body, and the workbook path was not yet wired. It is
wired now (`xlsx` is bundled, `rowsFromWorkbook` reads the attachment when the body carries
no table). Ray has been asked to re-send with the `.xlsx` attached. The night check reports
every refusal.

---

## The OBP feed

Every quantity in this email comes from OBP. The path it takes matters, because one stage
of it fails quietly:

| stage | what | owner | status |
|---|---|---|---|
| 1 | An app exports three CSVs from the OBP database at 00:00 EST into SharePoint `Inventory Reporting / Exports` | Jerwin Villaluz (Dec 2024) | works every night |
| 2 | A trigger refreshes `OBPInventoryReporting.Linked.xlsx` from those CSVs | same | **intermittent** — fired 5 days out of 46 (1 Aug–16 Sep 2026) |
| 3 | The flow "HON — nightly OBP" mails the workbook to `obp@cims.work`; `cims-hon` ingests it into `obp_inventory` / `obp_intransit` | Miguel's flow, `cims-hon` | works |

On 16 Sep 2026 the export said Allure had 17 magenta aboard; the workbook, and therefore
`obp_inventory`, said 10. Six days of this email were computed from 10 September stock and
the night check, which saw it from night one, had nobody to tell.

**So this Worker also reads the CSVs directly.** The same flow attaches them (step 2 in
*What Miguel has to do*), `obp-csv@cims.work` routes them here, `src/lib/obpCsv.js` parses
them and writes **this Worker's own tables** `weekly_obp_inventory` and
`weekly_obp_intransit`. `obp_*` is never written; it belongs to `cims-hon`.

Every reader — the runway check, the due-date check, the schedule-free gap check, the
quantity check — goes through `src/lib/obpSource.js` and takes **whichever copy is fresher**
by snapshot date, the CSV on a tie. If the CSV mail stops, the mirror's date pulls ahead and
the readers fall back on their own; the night check says so (`csv_feed`). `/health` shows
which copy is in use.

The consumption rates (`consumption_snapshot`, monthly) are still `cims-hon`'s and still
come from the workbook. A stale month there moves an average by a little; a stale on-hand
figure moves a stockout date by weeks. That is why on-hand and in-transit were done first.

---

## Ships with no Ordering Schedule

A ship's due dates come from the cruise line's **Ordering Schedule**, an Excel file the
ship's printer forwards to `obp@cims.work`. Without it the email falls back to open orders,
which is weaker evidence. Miguel, 16 Sep 2026: *"the email should say: you are missing this
file, do it first."*

So `src/lib/scheduleStatus.js` judges every ship in `FLEET_MAP` (Azamara excluded — their
dates are Ray's MLS) from `schedule_order` and from `cims-hon`'s own ingest log, and the
crew email opens with **DO THIS FIRST** naming *what went wrong last time*:

| status | what the log showed | what the crew is told |
|---|---|---|
| `never` | nothing loaded, no attempt | which file it is and where to send it |
| `image` | `no spreadsheet attachment … .png` | a picture is not the file |
| `nofile` | a mail with no attachment | send the file |
| `unreadable` | `0 DG3 orders … from 0 rows` | send the original, not a copy or PDF |
| `unmatched` | `could not map to a known ship` | put the ship name in the file name |
| `stale` | rows loaded, every due date passed | the schedule ended on *date*, send the new one |

On 16 Sep 2026 that was 13 ships: Ascent (screenshot), Millennium (unreadable), Navigator
and Xcel (no ship name), Allure (ended March 2026), and Beyond, Edge, Harmony, Infinity,
Ovation, Reflection, Silhouette, Solstice (never sent). A ship in that state is mailed for
that alone, with the subject *"send your Ordering Schedule"*, and the fleet email lists them
in one table.

---

## Going live to the fleet

**LIVE since 15 Sep 2026** (Miguel: "the one who has all the ships will go to onboardsupport;
the individual ships will go to each ship and cc Ray on each"). Every Monday 08:00 Miami:

| who | gets |
|---|---|
| `FLEET_TO` (onboardsupport@DG3.com) | the whole-fleet list |
| each ship with a finding | its own email, to the mailbox in `FLEET_MAP`, with `SHIP_CC` (Ray) in copy and `REPLY_TO` (Ray) on the reply |
| `DRY_RUN_TO` | nothing, unless `SEND_TO_FLEET` is set back to `"false"` |

`FLEET_MAP` carries all 48 ships. Every line comes from the `ship_contact` table in the
cims-timecard database (roles printer_specialist / printer / printer_manager), which names its
own sources per row; 47 of the 48 mailboxes are delivery-proven in cims-mail, Journey's is not
yet. `test/fleetMap.test.mjs` reads the map back out of `wrangler.toml` and fails on a missing,
duplicated, malformed or wrong-domain ship.

**The night after a Monday, the night check reads cims-mail's log** for that batch (binding
`MAIL`, read-only) and names any ship whose email bounced, was complained about, or is still
delayed. Forty-eight emails used to go out with nothing reading the answer.

To stand down for a week: set `SEND_TO_FLEET = "false"`. One line, no code change. To check
who would be mailed: **`GET /fleet`** (addresses masked unless `ADMIN_KEY` is passed) and
**`GET /preview-ship?ship=Apex`** for one crew's email as that crew would get it.

**An address is only ever used if a human typed it into `FLEET_MAP`.** Nothing in the code
derives a mailbox from a ship name. A guessed address either bounces, which is merely useless,
or lands in a real stranger's inbox carrying another company's operational data.

A ship with no mapping is **not dropped**. Its rows go to `DRY_RUN_TO` flagged as
undeliverable, and the night check reports it — the ships nobody can reach are the ones most
likely to miss a container.

---

## The night check remembers what it said

`WATCHDOG_TO` was emptied on 10 Sep 2026 because the check had no state and would have
repeated a standing finding every night until it was filtered. Between 11 and 16 Sep it then
flagged the frozen OBP feed every night and told nobody.

It now keeps `weekly_watchdog_seen` (its own table): a finding is mailed the night it
**first** appears, marked **NEW**; it is quiet every night after; a **critical** finding still
standing a week later is mentioned again once a week, marked *STILL STANDING n DAYS*.
"Nothing new since last night" is logged, not mailed. Engineering only — Miguel, never Ray.

---

## Sending one ship's email on demand

Nothing outside can call this Worker: `ADMIN_KEY` is unset and the workers.dev URL is not
reachable from a Claude session. So the trigger is a **row in D1**. Every 15 minutes the
Worker reads its own table `weekly_send_request` and sends any queued ship email exactly as
Monday would build it, to the ship's `FLEET_MAP` mailbox unless the row names addresses,
with Ray (`SHIP_CC`) copied plus whatever the row adds. The row is then marked done with the
mailer's answer, and `ingest_log` gets one line.

```sql
INSERT INTO weekly_send_request (ship, cc_json, note)
VALUES ('Voyager', '["Miguel.Sanmartin@dg3.com"]', 'test send, 16 Sep');
```

The Monday fleet path runs only on its own cron. Any other cron string is logged and sends
nothing.

---

## Check it works

| | |
|---|---|
| `/health` | deploy version, row counts, MOT coverage, addressing readiness, **whether any mail has ever arrived** |
| `/preview` | the fleet email as HTML, without sending it |
| `/preview-ship?ship=Apex` | one ship's own email, as that ship would receive it |
| `/fleet` | who would be mailed, and which ships are unaddressable (addresses masked) |
| `/states` | every eligible voyage and its classification |
| `/azamara` | what the MLS parser currently holds |
| `/po-not-recorded` | MLS and OBP disagree — Ray's list, never a ship's |
| `/quantity` | does the order that exists contain all four toners |
| `/anomalies` | inventory readings unlike this ship's own history |
| `/misses` | why each miss happened (read-only) |
| `/data-faults` | voyages with no due date — invisible to the weekly email |
| `/watchdog` | every night check with repair **off**; `?html=1` renders the digest |

### A push to a branch does NOT change what the live URL serves

Workers Builds deploys a **preview** for a branch push and reaches **production only from
`main`**. The build log says "production/builds/..." either way, which is what made this
worth writing down: a security change sitting green on a branch is not in force. On
10 Sep the `ADMIN_KEY` gate was called live on the strength of a green branch build while
`weekly-orders-email.sanmartin.workers.dev` was still serving `/states` to anyone who
asked. Check the Worker's Deployments tab, not the pull request.

### These endpoints need `ADMIN_KEY`

Every endpoint above except `/health` **refuses to serve without `ADMIN_KEY`**. Set it as a
Worker secret, then pass it either as the `x-admin-key` header or as `?key=<ADMIN_KEY>`.
Use the header for anything scripted: a key in a query string is recorded in browser
history and in every access log that keeps URLs. The query form exists because a browser
address bar cannot send a header.

They used to be public, and an earlier version of this file recorded that as a decision left
untaken. It stopped being defensible on 10 Sep 2026, within an hour: `azamara@cims.work` now
routes live fleet mail to this Worker, and Workers Builds publishes a preview URL for every
commit. `/states`, `/misses` and `/azamara` return the fleet's ordering position ship by ship,
which is a competitor's view of another company's supply chain.

**With no `ADMIN_KEY` set they return 503, not data.** An access control that quietly disables
itself when unconfigured is not one. The crons do not go through `fetch()`, so the Monday email
and the night check keep running either way.

`/health` stays open deliberately. It carries counts and readiness rather than the fleet's
position, and it is how you check that a deploy landed.

`npm test` runs **every** `test/*.test.mjs`. It used to run only `parse.test.mjs` while three
other suites sat green and unexecuted, which reads as coverage and is not. `test/run.mjs`
globs the directory so a new file cannot be missed again.

---

## The rules it applies

| | |
|---|---|
| Which voyages need an order | `HOTEL BIWEEKLY HOTEL` (Ray, 9 Sep 2026), plus `HOTEL MONTHLY*` for the ships that still schedule against it, plus Azamara. **Not `HOTEL MONTHLY` alone** — that was wrong for two days and made every Royal and Celebrity ship invisible. |
| Which MOTs are ours | `HOTEL BIWEEKLY HOTEL` only. The other 37 belong to other departments: "we can't touch, not even look at them." |
| The deadline | `ORDER DUE DATE`. It is **hard** — the last day the cruise line's shipboard inventory manager accepts an order or a change for that container. |
| Cadence | Ships use every *other* biweekly loading; ordered loadings sit 25–28 days apart. A miss is a **gap longer than that ship's own interval**, not simply an eligible voyage with no order. |
| Azamara | No ordering schedule. `Delivery date to BWS` from Ray's monthly MLS email is the due date. |
| What counts as ordered | A voyage with an open OBP order arriving on that loading date. **No PO = no order.** |

## Colour is data

In the Azamara MLS:

- green fill on the PO cell → `po_state = confirmed`
- PO present, no fill → `po_state = raised`
- PO blank with a Month → `po_state = none` ← **the miss signal**
- red font on a date → `date_changed = 1`, it moved since last publication

Any HTML-to-text step destroys this. `src/lib/azamaraMls.js` parses the markup, not the text.

## Quantities have to have a source

`src/lib/quantity.js` answers a different question from the rest of the Worker: not *is there
an order*, but *does the order contain what the ship needs*. An order can be raised on time,
carry a PO, and still be missing cyan.

Two of its rules stand on their own evidence and two do not, and they are configured
differently on purpose:

- **Colour completeness** and **an order with no toner at all** are self-evident from the
  order lines. A four-colour press needs four colours. No external figure is required, so
  these are **always on**.
- **The waste-box rule** stays **off**, and not because the number is unsourced. Ray
  confirmed 12 base and 24 on high volume, and `INV_06` says the waste box is exactly 12.
  It is off because 12 is a **par** — what should be *aboard* — and this check reads an
  **order line**. Comparing an order quantity to a par level is a unit error that would fire
  on every correctly sized top-up. Enabling it needs the on-hand figure too.
- **There is no USA/international buffer**, on purpose. The 9 Sep handover called the +3/+4 a
  nationality rule and an earlier version of this file repeated that. The CIMS Brain corrected
  it on 7 Sep 2026: transit time exists per port for 192 ports in days, and the buffer follows
  **delivery frequency and transit time, not nationality** — all five open ports are +3.
  Implementing it needs the 192-port transit table, still unparsed in R2.

A check that cannot read its columns reports **CANNOT RUN**, never a clean zero. `ran: false`
on `/quantity` or `/anomalies` is not a clean bill of health — read `reason`.

## Anomalies are judged against the ship, not the fleet

`src/lib/anomaly.js` exists for the Pursuit case: one keystroke, eight days undetected, a
near-miss air freight to Japan. No fleet-wide threshold would have caught it — the number was
not extreme, it was extreme *for that ship*. Every comparison is against that ship's own
trailing median, using median-absolute-deviation rather than a standard deviation, because a
mean is dragged by the very outlier it is meant to find. It also reports **how long** the bad
figure has been standing, which was the number that actually mattered on Pursuit.

## Known gaps

- **`azamara_rows` on `/health` is not evidence the ingest works.** Those rows can arrive by
  another path. `mail_received` and `last_azamara_mls` answer the question `azamara_rows` looks
  like it answers; the night check separates "the route does not exist", "mail arrives but
  never parses" and "Ray stopped sending", because each is a different person's problem. As of
  16 Sep 2026 the route works and the last MLS was refused (see above).

- **`miss_note` is derived but not written.** `/misses` produces the explanation for every
  miss from the row itself. It does **not** write to `cims-order`: that ledger belongs to
  `cims-order`, and the standing guardrail is that each app manages its own rows. Loading
  these values needs an explicit decision, not a side effect of a night run.
- **13 of 48 ships have no usable ordering schedule** (16 Sep 2026). The crew email now asks
  each of them for the file and says what went wrong last time; until they send it, their dates
  come from open orders. `/health` and the night check report the real coverage.
- **Ray's manual-order lead time is unknown.** For a ship with no schedule the email can only
  say "ask your Inventory Manager to check the next due date"; with a number from Ray it could
  say a date. Asked, 16 Sep 2026.
- **Consumption rates still come through the workbook.** See *The OBP feed*.
- The Azamara HOPO numbers (`PRHOPO08668`) are not the same identifier as the `JR0036` /
  `ON0037` / `ONMANUAL` voyage values in OBP. That mapping is still open with Ray, so Azamara
  ships are matched by due date and loading date, not by voyage.
- `schedule_order` is delete-then-insert per ship in `cims-hon`, so a due date that *moved*
  between publications is not visible there. This Worker parks the previous Azamara publication
  during the swap so `date_changed` survives.
