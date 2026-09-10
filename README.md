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

1. **Cloudflare dashboard → Workers & Pages → Create → Connect to Git**, pick
   `despensasupermercados/weekly_orders_email`, accept the defaults. Every push deploys from then on.
2. **Create the `azamara@cims.work` routing rule.** This is the one step that has actually
   failed. Ray was asked to cc the address before the address existed, and on 10 Sep 2026 his
   MLS bounced back to him:

   ```
   <azamara@cims.work>: host route1.mx.cloudflare.net said:
       550 5.1.1 Address does not exist
   ```

   That error comes from Cloudflare, not from DG3: the MX for `cims.work` is Email Routing and
   Email Routing has no rule for `azamara`. In the dashboard, on the `cims.work` zone:

   | | |
   |---|---|
   | Email → Email Routing → Routing rules → **Create address** | |
   | Custom address | `azamara@cims.work` |
   | Action | **Send to a Worker** |
   | Destination | `weekly-orders-email` |

   Leave the existing `obp@cims.work` rule alone — it belongs to `cims-hon`.

   Then **verify, do not assume**: send any mail to `azamara@cims.work` and check
   `GET /health`. `mail_received` must go above zero. It counts mails that reached *this*
   Worker, so it is the only field on that endpoint that proves the route exists.

There is **no mail secret to add.** Sending goes through the `MAILER` service binding to
`cims-mailer`, which holds the only Resend key in the estate and reads no `Authorization`
header. **There is no `MAILER_URL` and no `MAILER_TOKEN`.** An earlier version of this file
told you to create both; the code then invented a URL-and-token interface that does not
exist, and a Resend key ended up pasted into a plaintext Worker variable. Do not add them back.

The D1 bindings and both crons are already in `wrangler.toml`.

### Ask Ray for one thing

> "Can you attach the Azamara MLS as an .xlsx as well as pasting it into the email?"

The body path is what actually runs today. An attachment is **detected and logged but not
parsed** — `rowsFromWorkbook()` exists and takes the xlsx library by injection, but no library
is bundled into this Worker. The attachment is worth having anyway: it keeps the cell colours,
and colour is data in that file.

---

## Going live to the fleet

`SEND_TO_FLEET` is `"false"`. While it is false the Monday cron mails the whole list to
`DRY_RUN_TO` — Miguel and Ray — and no ship hears anything.

To go live:

1. Fill in **`FLEET_MAP`**: `Ship = address, address; Ship = address`. Newlines and `#`
   comments are allowed.
2. Run **`GET /fleet`**. It prints which ship would be mailed at which address, and which
   ships have something due and **cannot be reached at all**. Read this before step 3.
   Addresses are masked by default; set `ADMIN_KEY` as a secret and pass `?key=` to check them
   character by character.
3. Run **`GET /preview-ship?ship=Apex`** to see one crew's email as that crew would get it.
4. Set `SEND_TO_FLEET = "true"`.

**An address is only ever used if a human typed it into `FLEET_MAP`.** Nothing in the code
derives a mailbox from a ship name. A guessed address either bounces, which is merely useless,
or lands in a real stranger's inbox carrying another company's operational data.

A ship with no mapping is **not dropped**. Its rows go to `DRY_RUN_TO` flagged as
undeliverable, and the night check reports it — the ships nobody can reach are the ones most
likely to miss a container.

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

- **`azamara_rows` on `/health` is not evidence the ingest works.** On 10 Sep 2026 it read 14
  while not one MLS had ever reached this Worker — those rows arrived by another path and
  nothing can refresh them, so an Azamara date that moves will not be seen. `mail_received` and
  `last_azamara_mls` are the fields that answer the question `azamara_rows` looks like it
  answers. The night check reads the same three facts and separates them, because "the route
  does not exist", "mail arrives but never parses" and "Ray stopped sending" are three
  different people's problems and a bare silence names none of them.

- **The workbook path is not wired.** An attached `.xlsx` is detected and named in the ingest
  log, not parsed. Bundling an xlsx library into the Worker is the remaining work.
- **`miss_note` is derived but not written.** `/misses` produces the explanation for every
  miss from the row itself. It does **not** write to `cims-order`: that ledger belongs to
  `cims-order`, and the standing guardrail is that each app manages its own rows. Loading
  these values needs an explicit decision, not a side effect of a night run.
- **38 of 48 ships still have no ordering schedule loaded.** That is a data problem, not a
  code one — the resends to `obp@cims.work` fix most of it. Until then `/health` and the night
  check both report the real coverage rather than implying fleet-wide protection.
- The Azamara HOPO numbers (`PRHOPO08668`) are not the same identifier as the `JR0036` /
  `ON0037` / `ONMANUAL` voyage values in OBP. That mapping is still open with Ray, so Azamara
  ships are matched by due date and loading date, not by voyage.
- `schedule_order` is delete-then-insert per ship in `cims-hon`, so a due date that *moved*
  between publications is not visible there. This Worker parks the previous Azamara publication
  during the swap so `date_changed` survives.
