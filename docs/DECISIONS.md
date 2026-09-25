# Decisions, lessons and backlog — weekly_orders_email

Kept in the repo because a code session depends on it (Miguel, 24 Sep 2026:
everything a session depends on lives in the repo). The Brain holds the same
facts with record ids; this file is the copy a session can read without a
connector. Newest at the top of each list. Dates are 2026.

## Decisions that shape the code (do not re-open)

- **25 Sep — Azamara toner tolerance is ZERO days (Ray).** Asked how many days
  without an item is acceptable on Azamara. Ray answered with the Azamara toner
  par table: `Days without item = 0` on every toner, note "if item drops to 0,
  printer needs to communicate immediately". So the red line in the ship email
  ("It will arrive N days after you run out. If you cannot wait, tell your
  Inventory Manager now") STAYS for Azamara. It is the as-needed trigger Ray's
  low-stock model depends on. Paper tolerance was not answered; do not chase it
  until a paper gap on an Azamara ship is called "fine" by Ray.
- **24 Sep — there is no 28-day rule (Ray).** He was reading the email's own
  "none for 28 days" line back to us. Nothing to build.
- **24 Sep — Azamara holds small onboard stock by design and Ray ships more as
  needed** ("inventory cost goes up and some products move very slowly"). The
  top-ups appear as in-transit lines outside any schedule row; the email counts
  them once they are in transit. Quest's schedule row due 19 Oct lands 7 Feb
  2027 (111 days) while the row due 8 Dec lands 18 Dec: both are Ray's MLS as
  published, not a parse error.
- **24 Sep — Miguel on the two design questions of 17 Sep:** (a) a voyage with
  no PO is an issue and gets warned, even in a ship's usual skip slot (code was
  already right); (b) "filter by due date" means SORT by due date (already
  done).
- **23 Sep — Ray chose "show both".** The burn rate stays `MAX(last month,
  trailing average)` (his SOP). The ship email prints both inputs under the
  headline when they differ: `11 last month · 8 average of 2 months · we plan
  on the higher one`. The average is over however many months are measurable
  (usually 2, never assume 3) and the label prints the true count.
- **23 Sep — Infinity RADIANT WHITE: 6 was June, 11 was August.** Ray still
  quotes 6. Corrected twice by email; not landed. Decision: stop emailing it,
  the Monday line carries the figures.
- **22 Sep — the night check is for ops, not crews.** Coverage ("could not
  check") goes to the ops digest only. No new automated mails to crews or to
  Miguel; the coverage check runs weekly with the send.
- **21 Sep — Miguel: "I want this to run every Monday; more emails my people
  will not read."** Noise in the night check was cut from 158 warns to 9 by
  measuring every rule against 1,200 live series first (PR #25).
- **21 Sep — sender codes SL = Solstice, SI = Silhouette, AT = Ascent
  (Miguel, with evidence).** Fact. cims-hon still has to add them.
- **16 Sep — Ray: no fixed lead time for manual orders.** For a ship with no
  schedule the email says "ask your Inventory Manager to check the next due
  date" and never invents a date.
- **16 Sep — Miguel: who can do what.** Crew can only add to an order that has
  a due date; the Inventory Manager confirms the date; Ray approves and buys.
  The email never tells a printer to raise an order of their own.

## Standing rules for anyone touching this repo

- Develop on `claude/tender-cannon-jpjazq`; every PR merged to `main` deploys
  through Workers Builds. Create and merge your own PRs (Miguel's standing
  instruction) once tests pass and the deploy is verified.
- `ingest_log` is SHARED with cims-hon. Every read filters
  `source = INGEST_SOURCE`. `test/watchdogScope.test.mjs` counts every
  `FROM ingest_log` in the shipped SQL and fails if one is unscoped.
- Every send-failure note is built in `src/lib/sendNote.js`; the night check
  builds its SQL from the same constant. Never write the words by hand.
- A zero is a claim, a null is an absence. Never coerce a missing on-hand to 0.
- Never modify or redeploy cims-hon; never write other apps' D1 rows; `obp_*`
  and `schedule_order` are never written; never touch the `obp@cims.work`
  routing rule. `src/cims-mast.js` is byte-locked.
- There is NO `MAILER_URL` and NO `MAILER_TOKEN`. Sending is the `MAILER`
  service binding only. An address is only ever one a human typed in
  `FLEET_MAP`.
- DG3 / CIMS email is Outlook / Microsoft 365 only. Never Gmail.
- READ THE ENTITY'S `corrections` FIELD in the Brain before writing any rule
  about a ship, quantity or date into code (missed on 10, 16 and 18 Sep;
  Legend of the Seas was dropped from a week of emails because of it).

## Lessons paid for, 20–25 Sep

1. **Read the other app's source before proposing a change to it.** I
   recommended try/catch for cims-hon's 421 bounces; it was already there and
   had never fired in 230 messages. The real cause was the Worker being
   terminated (CPU/memory), which try/catch cannot see. Fix: store then
   process (`docs/cims-hon-inbound-mail-spec.md`); cims-hon shipped it 21 Sep.
2. **Confirm which reader consumes a table before calling it a problem.** The
   mirror `obp_inventory` is frozen since 14 Sep; the Monday emails never read
   it because `obpSource.js` takes the fresher of mirror and CSV.
3. **Narrowing a match pattern needs the full inventory of writers.** PR #26
   narrowed the failure match to `%send FAILED:%` and blinded the night check
   to 4 of the 8 ways a send can fail (on-demand, THREW, per-ship NOT SENT).
4. **Verify the thing that fails, not the thing that works.** Twice I verified
   that queries return rows when the question was whether a failure is caught.
5. **Read the test COUNT, not the tail.** A backtick inside a SQL comment
   broke four test files; the tail said `ok`, the count said 19 of 23.
6. **Fault-inject every guard.** A guard not shown to bite is decoration.
7. **Print the inputs, not just the answer.** Ray disputed "11 a month" from
   memory; the data said 11. Showing both inputs ended the argument.
8. **Quote a design question verbatim when relaying it.** A paraphrase
   inverted question (a) of 17 Sep; Miguel's principle still resolved it.
9. **Regex-bearing edits go through the Edit tool, not a python heredoc**
   (escaping mangled `\r?\n`).
10. **An emailed correction that has not landed after two tries is not fixed
    by a third email.** Put the number where the reader already looks.

## Backlog — not built, on purpose

- Fleet-wide toner wording. "If you cannot wait" is softer than Ray's
  zero-tolerance for toner. A possible line: "Toner cannot reach zero. Tell
  your Inventory Manager today." Needs Miguel's yes; not a bug.
- Azamara paper tolerance (see decisions). Ask only when it matters.
- Night check standing warns (25 Sep: anomaly 6, coverage 1, duplicates 1,
  scope 1) are questions nobody acts on, left as warns on purpose. The two
  standing criticals are `feed_frozen` on the mirror tables and clear only
  when cims-hon retires the linked workbook.
- Is there a dead-man check for "the night reader did not run and nothing
  said so" (Action rechqPhm6CGR4XLGt, 17 Sep)? Not verified this week.

## Open on other people's side

- **cims-hon:** add SL/AT/SI to `shipCodes.js` and re-feed the parked files
  under `unparsed/` (Solstice still has 0 schedule rows; Action
  recrCrjPTxYznrBPH). Retire the frozen linked workbook or repoint HON at the
  CSV export (rec1iiLB86ZwLFsNk, recGwzmL0tcZmPSuC). An inbound-refusal alarm
  on `obp@cims.work` (recLzeixD5h8FvpDH). See
  `docs/cims-hon-handoff-2026-09-21.md`.
- **Ray:** nothing pending. Both questions of 24 Sep are answered.
