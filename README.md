# weekly_orders_email

Cloudflare Worker with two jobs:

1. **Catches Ray's Azamara MLS** — including when he pastes the table into the email body
   instead of attaching a file, which is what the current `cims-hon` ingest misses entirely.
2. **Sends the weekly orders email** every Monday 08:00 Miami time — the ships whose order
   due date falls in the next 7 days with nothing raised against it.

The purpose is narrow: stop paying emergency shipping because a printer forgot to raise an order.

---

## What Miguel has to do (three clicks, once)

1. **Cloudflare dashboard → Workers & Pages → Create → Connect to Git**, pick
   `despensasupermercados/weekly_orders_email`, accept the defaults. Every push deploys from then on.
2. **Settings → Variables → add two secrets:**
   - `MAILER_URL` — the cims-mailer endpoint
   - `MAILER_TOKEN` — its auth token
3. **Email → Email Routing → add a rule** sending a copy of the Azamara MLS mail to this Worker.
   Easiest is to have Ray also cc `azamara@cims.work` and point that address here, so the
   existing `obp@cims.work` routing is left alone.

The D1 bindings and the cron are already in `wrangler.toml`. Nothing else to configure.

### Ask Ray for one thing

> "Can you attach the Azamara MLS as an .xlsx as well as pasting it into the email?"

The Worker handles both, but the attachment is the reliable path — it keeps the cell colours,
and colour is data in that file.

---

## Check it works

- `GET /health` — deploy version and row counts.
- `GET /preview` — the weekly email as HTML, in the browser, without sending it.
- `GET /azamara` — what the parser currently holds for the four Azamara ships.

Run `/preview` before letting the Monday cron send anything to the fleet.
`SEND_TO_FLEET` is `"false"` until you change it, so the cron mails you and Ray, not 48 ships.

---

## The rules it applies

| | |
|---|---|
| Which voyages need an order | Only those with a `HOTEL MONTHLY*` row in the ordering schedule. A ship has 19–28 voyages in six months but raises 5–7 orders. |
| The deadline | `ORDER DUE DATE`. It is **hard** — the last day the cruise line's shipboard inventory manager accepts an order or a change for that container. No favours, no exceptions. |
| Which due date, when a voyage has several | The earliest across all supply streams. Median 9–14 days before the hotel one, so acting on it is never late. |
| Azamara | No ordering schedule. `Delivery date to BWS` from Ray's monthly MLS email is the due date. |
| What counts as ordered | A voyage with a matching `VoyageNum` in the OBP in-transit (open orders) tab. **No PO = no order.** |

## Colour is data

In the Azamara MLS:

- green fill on the PO cell → `po_state = confirmed`
- PO present, no fill → `po_state = raised`
- PO blank with a Month → `po_state = none` ← **the miss signal**
- red font on a date → `date_changed = 1`, it moved since last publication

Any HTML-to-text step destroys this. `src/lib/azamaraMls.js` parses the markup, not the text.

## Known gaps

- The Azamara HOPO numbers (`PRHOPO08668`) are not the same identifier as the `JR0036` /
  `ON0037` / `ONMANUAL` voyage values in OBP. That mapping is still open with Ray, so Azamara
  ships are matched by due date and month, not by voyage.
- `schedule_order` is delete-then-insert per ship in `cims-hon`, so a due date that *moved*
  between publications is not visible there. This Worker parks the previous Azamara publication
  during the swap so `date_changed` survives.
