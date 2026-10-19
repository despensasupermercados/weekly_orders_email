# Decisions, lessons and backlog — weekly_orders_email

Kept in the repo because a code session depends on it (Miguel, 24 Sep 2026:
everything a session depends on lives in the repo). The Brain holds the same
facts with record ids; this file is the copy a session can read without a
connector. Newest at the top of each list. Dates are 2026.

## Decisions that shape the code (do not re-open)

- **19 Oct — floor-model toner stays on last month until Ray answers
  (measured, not built).** Ray spot-checked five ships of the 19 Oct email.
  He confirmed all five real gaps it listed and added none, but called 14
  Azamara floor-model rows okay, at about 1 a month against the email's 2 to
  5 (OBP last month). Re-running the repo's engine on the 19 Oct data with
  floor-model toner and bottles on a 6-month count-based average (paper and
  C4070 unchanged): 26 rows → 18, his 5 gaps kept, 8 of his "okay" rows gone,
  no new row in the fleet. His flat 1 would have missed two of his own gaps.
  Not built because it departs from his written rule ("last month", 12 and
  15 Oct) on one week of evidence: one question to him first, drafted for
  Miguel, then a 12 Oct replay as the second check. Detail in
  `docs/RAY-LOGIC.md` §5.5; Brain recE26GAvkxgfOsbk.

- **16 Oct — the ordering rules are published for every app (Miguel).** "should
  be cross pollinated to the Brain and across the apps that use it .. coz is
  very important." A second copy of the port lists in cims-hon would be a
  second definition that drifts, so the definition stays in this repo and
  `src/lib/orderingRules.js` writes it each night (06:00 UTC cron, before the
  night check) into `weekly_ordering_rules` in D1: usage, toner spare, paper,
  radiant, waste box, MFD par, 113 port classes; 133 rows. Values are
  generated from `tonerSpare()`, `deliveryClass()` and the constants, never
  retyped. Rows from an earlier night are removed only after every write that
  night succeeded, so the table is never empty. A failure is logged and never
  stops the night check. First load done by hand on 16 Oct (133 rows). Four
  fault injections, each caught.
- **16 Oct — HON's change is written, not made.** Push access to cims-hon was
  refused by the session's permission check. The brief and a paste-in prompt
  are in `docs/cims-hon-ordering-rules-handoff-2026-10-16.md`: last-month
  usage, the +3/+4 spare read from `weekly_ordering_rules`, Azamara flat +3,
  seven acceptance cases, and the INV_04 / INV_06 update.

- **15 Oct — print-shop toner spare: +3 at home, +4 long-haul (Ray).** Asked
  whether the spare is 3 everywhere, Ray: "USA ships have a 3+ rule and
  international ships have a 4+ rule, if a ship is leaving the USA, you will
  normally start processing their international orders -3 months in advance,
  which already has to have the 4+ rule. if the ship is returning to USA, the
  3+ rule will come into play when they do their first order here." With his
  7 Sep answer (Vancouver, St Maarten, Oranjestad, Freeport, Puntarenas are
  "international" but delivered within the month), the line is delivery
  frequency: US, Canada, Caribbean islands +3; Europe, Asia, Australia, South
  America +4. Which order: +4 when the open order loads at a long-haul port or
  the next loading does (the September spec: "the last US order before the
  ship goes international takes +4"); the first order back in the USA with a
  US loading after it is +3. Azamara stays a flat +3 (September spec, not
  re-confirmed). A port on neither list gets +3 and the email line names it as
  not on file. Source: `schedule_order.loading_port`, 364 of 366 future orders,
  38 spellings, all classified. Today the +4 applies to Anthem, Edge, Equinox,
  Infinity, Millennium, Navigator, Quantum and Spectrum. The 12 Oct replay has
  no print-shop toner row, so that email would not have changed. Seven fault
  injections each caught. Supersedes "+3 at every open port" (7 Sep), which
  was a wait for the port data, not a rule. PR #46; Brain recaGgsFr06d19lkW.
- **15 Oct — usage: last month, for HON too (Ray).** "for the HON, i would
  recommend using the last month number only and guide the adjustments for
  the future based on that. the average should be viewed more for dry dock or
  quite months as the usage can pickup at any time." The email already does
  this. A numeric quiet-month switch (last month under half the average →
  plan on the average) was measured on the 12 Oct replay and rejected: +3
  rows, one of them Spectrum cyan, which Ray struck on 13 Oct. HON's
  greater-of rule is retired; the change is cims-hon's to make.

- **14 Oct — OBP's own monthly usage is the figure we plan on (PR #40).**
  Ray exported September's Consumption Statistic (Azamara / ROYAL / CEL Sept
  OBP.xlsx, one sheet per ship by two-letter code; all 49 codes mapped by
  matching Ending Inventory to our 1 Oct count: 48 ships exact, HE = Hero).
  Loaded into `weekly_obp_consumption` (443 consumable rows, source
  `ray-export`); runwayDb reads it as last month's usage ahead of the figure
  computed from counts, and the email line says "(OBP)". Replay of 12 Oct:
  28 rows → 24; Spectrum cyan, Silhouette radiant, Infinity yellow (all three
  Ray struck), Pursuit paper drop; Quest TN324BK/TN324C appear (receipts our
  copy never had).
  CORRECTION of 13 Oct: OBP's usage ≠ Begin + Additions − End on every row.
  On 5 of 419 September rows every input equals ours and OBP's usage is still
  10 lower (Ascent 8.5x11 44+40−35 = 49, OBP says 39; Brilliance ×2;
  Constellation) or 15 lower (Silhouette radiant 22+0−6 = 16, OBP 1). So the
  13 Oct claim "the error is our August closing count" was wrong for those
  rows: our counts matched; OBP subtracts something its counts do not show.
  The other 14 differences were receipts (Quest, Spectrum, Infinity: stale
  workbook) and one wrong August count (Pursuit). CONSEQUENCE: our own
  month-open + receipts formula reproduces OBP on ~99% of rows and overstates
  the rest. Ray's export is the source of truth; ask him for it each month
  (1st week). Our formula stays the fallback. Ray answered the same evening:
  transfers out ("10 cases transferred to Legend"; "the other ship accepts
  the order on OBP"); Silhouette radiant is with IT. His "Nov start" files of
  14 Oct are October 1–14, not loaded (`docs/RAY-LOGIC.md` §4.2, §4.10–12).
- **13 Oct — review by execution of the runway logic (PR #39). Four bugs,
  one latent guard, two left alone on purpose.** Each measured on the 12 Oct
  data with the repo's own SQL; the fixes change 23 rows → 28 and one quantity.
  1. A delivery landing before the shelf emptied silenced the finding even
     when the OPEN ORDER was the only route out of the dry spell. Onward: cyan
     4 aboard at 3 a month, 1 landing 7 Nov, dry 1 Dec, order due 3 Dec lands
     5 Feb, nothing else coming — not printed; the same ship WITHOUT the
     November delivery was always printed. Four Onward toner/paper rows plus
     Onward 11x17 (order lands 5 Feb, dry 6 Feb). Rule now: with a delivery
     first, silent only when there is no open order, or when the shelf lasts
     past the landing AFTER the open order (Ray struck every such row on
     13 Oct: 14 rows, unchanged). Edge/Summit test cases from 12 Oct asserted
     the wrong thing and were flipped.
  2. "Still aboard when the order lands" was zero whenever the shelf emptied
     before the landing, ignoring deliveries in between. Pursuit TNP75 (MFD par
     5): "add 5" with about 4 aboard on 24 Feb → "add 1". Now a day-by-day
     balance walk (`balanceOn`). Affects par top-ups only.
  3. A late in-transit line (counted as arriving today since PR #33) printed
     "N more arriving <today>". Explorer: 12 waste boxes on a June PO, 31 days
     past date, 18 already aboard. The email now says "N more overdue since
     <OBP's date>". Lateness on 13 Oct: 33 lines 1–7 days, 5 lines 8–30, 1
     line 31 days; nothing older.
  4. `LAG(on_hand)` took the previous ROW, not the previous MONTH; the SQL
     comment claimed a gap "drops out", it did not. Guard added. Latent: all
     10,106 month pairs Jun–Sep are consecutive today.
  Left alone: (a) Quest's open order is picked by earliest DUE (19 Oct → lands
  7 Feb) while a later-due order lands 18 Dec; retargeting would drop the ask
  for the 7 Feb landing, which closes 19 Oct. OBP shows Quest lines landing
  8 Dec, the MLS says 18 Dec — a date disagreement for Ray. (b) `severity` on
  runway findings is always 'critical' and nothing reads it; dead field.
  (c) Print-shop toner quantity (cycle + 3) ignores stock aboard at landing;
  Ray's own marks go both ways (Freedom 0, Legend +40), so it waits for him.
- **13 Oct — Ray marked the month-end sample: 2 Y, 24 N. The spare-stock
  method is NOT built.** (`Ray method sample 12 Oct 2026 RG.xlsx`, reply to the
  "Orders due this week" thread.) His rules, in his words:
  - Q1 "Paper and toner is by consumption, paper is ordered in sets of 40
    cases based on previous months consumption."
  - Q2 "local vessels are 3 months orders while international ships hold 6
    months of orders" (the pipeline of planned deliveries, not a check window).
  - Q3 zero last month → plan on the average: "correct". Live since PR #34.
  - Q4 "It becomes a concern when the paper drops below the usage level, which
    then it becomes an emergency depending when next order is expected to
    arrive." That is the live rule: a row when the ship runs dry before the
    next delivery. All five "dry after the open order lands" items (Freedom,
    Silhouette, Constellation, Ascent, Reflection paper) were in the sample;
    he marked all five N. Do not build month-end spare or that gap.
  - Q5 Wonder: twice-monthly pallets cover usage; "minimum of 40 cases till
    next orders arrive".
  Y: Legend (+40, he already asked the vessel), Infinity yellow (but his note
  says usage is low, ~3 + 4 spare; the shelf agrees: 2 used 1–13 Oct). His
  Silhouette-radiant note ("had 33, usage around 7") matches SOLSTICE's
  figures, not Silhouette's (6 on 1 Oct). Asked.
  DATA: his "had X cases" = our 1 Oct CSV count on 22 of 22 rows. Usage
  matches on 18; four rows are exactly 10 higher in ours (Ascent 8.5x11,
  Brilliance x2, Constellation 11x17). OBP receipts (weekly_obp_order) match
  ours; the gap is our AUGUST closing count, taken from the stale workbook
  mirror via cims-hon's consumption_snapshot. Same cause as Silhouette radiant
  (22 vs OBP's implied 11). Infinity yellow's 16 is a booking-timing artefact
  (8 booked received 28 Sep, on the shelf count 6 Oct). Fix: from 1 Nov,
  usage = 1st-of-month count (weekly_obp_month_open) + receipts
  (weekly_obp_order) − next 1st-of-month count, our own copy of OBP's formula.
- **13 Oct — the OBP workbook is being retired; the CSVs are the feed.**
  OBPInventoryReporting.Linked.xlsx is re-saved every night (~04:01 UTC) but
  its values change only when someone opens it in desktop Excel: obp_inventory
  held 8 Oct's content (3550 / 14269) through 12 Oct, then exactly the CSV of
  that day; same for 1 Oct. Power Automate cannot refresh Power Query, so
  "make it refresh daily" has no reliable fix, and it would only re-serve the
  CSVs anyway. The CSVs change once a day (OBP export, 04:00 UTC); the 09:00
  and 21:00 UTC mails carry the same files. `acceptedorderdetails.csv` is now
  stored in `weekly_obp_order` (ISO dates, 3 days kept) for cims-hon, which
  still builds receipts and consumption from the workbook. The night check now
  judges feed age and movement on the copy the readers use; a stale workbook
  is one worth-knowing line, a retired one is silence. Last step, Miguel's:
  remove the workbook email from "HON — nightly OBP" once cims-hon reads
  `weekly_obp_order`.
- **12 Oct — a dry spell between two planned deliveries is a finding.** The
  stock walk now sees every planned landing (late ones as today). An item that
  runs dry between two deliveries, before its open order can land, is shown
  with "If you cannot wait, tell your Inventory Manager now". That sentence
  now ends EVERY dry gap; it used to appear only when the order itself closed
  the gap (Ray 25 Sep: this line is the Azamara as-needed trigger). The
  headline names deliveries counted in the empty date ("8 more arriving Sat
  14 Nov"). Replayed on 12 Oct: 18 rows → 23, all five new (Infinity TN619Y
  dry 30 Nov–8 Dec, Quest TN619M 1–8 Dec, Pursuit 8.5x11 10–19 Dec, Quest
  TN324M 20 Dec–7 Feb, Spectrum TN619C 26 Dec–6 Jan); none changed. NOT
  built: a gap AFTER the open order lands (five paper items, Jan–Feb) — that is
  Ray's month-end planning, in his sample. Dry only after the last planned
  delivery stays the next order's business (the 47 → 272 lesson, 16 Sep).
- **12 Oct — Ray: "the usage used was from last month."** In writing, after
  his review. The rate is now last month's usage (`runwayDb.js`, `RATE`). The
  average stands in only when last month has no figure, or reads ZERO for an
  item used before: Ray's sheets never show a zero month, so his rule for it is
  unknown and was asked; planning on zero would have dropped Quest's WX-103
  waste box (0 aboard) from the email. The ship email now says "we plan on last
  month" (or "on the average" when it fell back). Replayed on 12 Oct's data:
  21 rows → 18 (Solstice radiant and Freedom yellow, both struck by Ray, and
  Quest TN324BK, 4 aboard at 1 a month); Ray's six now 5 of 6 (was 2). The
  sixth, Legend +40, needs his month-end spare rule. He also wrote: "the
  statistics shows what is expected to be ordered in the coming months,
  subject to change based on actual consumption", "Legend will need paper
  even during the transition to USA at lower usage", and "Jewel will also be
  required to align their paper order".
- **12 Oct — Miguel: "don't ask me to merge anything, go ahead and do it all."**
  Sessions merge their own PRs once tests pass and the change is measured.
- **12 Oct — Ray reviewed the 12 Oct fleet email (`email stats 10122026.xlsx`).**
  We matched him on 2 of 6 items. Causes, each proven on data (Brain
  recm81KqiNOmmYrKY, rec28jc86U9FZ6KRL):
  1. Late in-transit lines were ignored (Oasis). FIXED: a line still in transit
     with a past ETA counts as arriving today. Replayed on Monday's data: 6 of
     27 rows drop (Oasis, Eclipse, Equinox x2, Quantum, Summit), each because
     that exact item was already shipped 1–8 days late; none added.
  2. "More is coming on <date> first" printed about the order itself, and
     "already has enough" beside "none for N days" (Silhouette). FIXED.
  3. Usage rate: Ray's sheet uses LAST MONTH (42 of 44 rows), not the higher of
     last month and the average. FIXED 12 Oct after Ray confirmed (above).
  4. No spare: Ray keeps about one month of usage on board at each month end
     (Legend, Jewel). OPEN — his method scores 5/6 on replay but adds ~30 rows
     he has not seen; needs his review of a sample before it goes live.
  5. Usage derived from the stale workbook mirror (Silhouette 16 vs OBP 5).
     OBP's Consumption Statistic = day-1 count + receipts − last-day count; our
     1st-of-month CSV equals OBP's month-end count on 44 of 44 rows. Each
     month's opening count is now kept (`weekly_obp_month_open`, PR #32).
     October is the first month we can rebuild and check against OBP (1 Nov).
  Counting every in-transit delivery: the part that finds hidden dry spells
  was built the same day (entry above); the part that plans spare stock after
  the order lands belongs with Ray's method.
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
- **23 Sep — Ray chose "show both".** (The MAX rule it kept was retired on
  12 Oct; see above.) The ship email prints both inputs under the headline when
  they differ: `11 last month · 8 average of 2 months · we plan on last
  month`. The average is over however many months are measurable
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

- Ray's monthly export is loaded with `tools/ray-export.mjs`, never by hand;
  it refuses a month in progress. A rule change is proven with
  `tools/replay.mjs` on the fleet's own data before it ships. Both, and the
  fallback SQL for a month Ray has not sent, are in `tools/README.md`.
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
- A PUSH TO THE BRANCH IS A PREVIEW. Production changes only from `main`
  (README, verified 10 Sep). The Cloudflare `workers_get_worker_code` tool
  returns the LATEST UPLOADED VERSION, preview included, so it cannot prove
  what is live: on 6 Oct it showed the unmerged PR #32 code while production
  still ran the pre-PR build. The handoff's "workers_get_worker_code proves
  what is deployed" was wrong. Proof of a deploy is the Worker's Deployments
  tab, or behaviour observed in D1 (a night-check line, a log wording that
  only the new code writes).

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

## Review of 6 Oct 2026 — four bugs in my own work, each proven by a failing test first

Eleven days of production evidence first (two Monday sends, 9 of 9 and 12 of
12 delivered; the monthly chase reached Solstice; no send failures), then the
code of PRs #24 to #30 re-read by execution. Fixes on the branch, not merged:
Miguel asked for corrections, not a deploy.

1. **Night-check memory called a returned finding "still standing".** The
   feed_frozen criticals stood 17–30 Sep, the mirror refreshed on 30 Sep, the
   finding was absent 1–5 Oct, and the 6 Oct digest said "STILL STANDING 19
   DAYS". The row never forgot (it ages out only after 30 unseen days) and the
   reminder clock ran from first_seen. Now a finding whose last_seen is older
   than the last night the check RAN is a return: mailed as fresh, tagged
   BACK with the date it was last seen, clock restarted. The last run night is
   read from our own "night check" log lines, so a night the cron did not fire
   is not mistaken for a clearance.
2. **A hand-queued chase for a compliant ship was logged as a failed send.**
   The per-ship line read "NOT SENT … not chased", onDemandOutcome marks every
   NOT SENT line, and the night check raises a critical on the mark. The skip
   is now its own word, SKIPPED, and carries no mark.
3. **"N of 48 ships ok" counted every name any check saw.** The OBP export
   carries warehouses ("DIS WHS", "MIAMI WHS") and a hull not in service
   ("Hero"), and a troubled ship spelt differently in its finding and in the
   checked list counted as both troubled and clean. Today the data lines up
   (48 par ships, 48 addressed, one spelling), so the live number was right by
   luck. The count is now over the addressed ships coverage examined, matched
   by normalised name.
4. **The 2021-history rule keyed on an EMPTY loading date only.** A 2021 row
   with a malformed loading date ('5/3/2021') still landed as a NO_LOADING_DATE
   critical. The rule now treats any unusable loading date on a voyage older
   than any crew can act on as history.

Lesson for the list above: **production answered back on bug 1 within eleven
days; bugs 2 to 4 were latent and only a re-read by execution found them.**
Read the live log before the code, then the code with a fault injected.

## Backlog — not built, on purpose

- **The average drops a negative month and keeps its inflated neighbour
  (found 19 Oct).** A receipt booked in one month and counted on the shelf in
  the next (§4.4 of RAY-LOGIC.md) shows as one high month and one negative
  one; `runwayDb.js` drops the negative as a typo and averages the high one.
  Quest TNP75 on 19 Oct: August 6, September −3 (dropped), so the email
  printed "5 average of 2 months"; the counts over the same three months say
  2 a month (3 aboard end of June + 6 received − 3 aboard end of September).
  It matters wherever the email plans on the average, which is when last
  month reads zero (Quest TN514Y: average 3, counts 1.3). The cure is the
  count-based window measured in RAY-LOGIC.md §5.5 (start count + receipts −
  end count), so it waits on Ray's answer to that question rather than
  being fixed twice. Fleet-wide impact not measured.
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
- **Ray (13 Oct):** both questions answered (see decisions). Open: his
  Silhouette-radiant note reads as Solstice's figures; Infinity yellow "Y"
  beside "low usage"; OBP's September Consumption Statistic for the fleet, to
  replace the four-plus rows our mirror-derived September usage gets wrong
  until our own October figure exists (1 Nov).
  Also: Quest's order due 8 Dec — OBP lines land 8 Dec, the MLS says 18 Dec;
  which is right? Explorer's 12 waste boxes (PO229591RCL, dated 12 Sep) — still
  coming, or a dead line to close in OBP?
  Answered 14 Oct: Silhouette note was Solstice's numbers (Silhouette in the
  USA, radiant not used, orders altered as needed); Infinity yellow "okay with
  current projected orders"; September export sent. New: what does OBP
  subtract on Ascent 8.5x11 (44 + 40 − 35 = 49, file says 39)? Please send the
  same export in the first week of every month.
  Answered 14 Oct (later): **Quest** — the MLS is right: due 8 Dec → on board
  18 Dec, due 18 Dec → on board 5 Jan. OBP's 11 lines (70 units, ordered
  8 Oct) carry the 8 Dec DUE date as their ETA, so the stock walk counts them
  ten days early. Fleet-wide check 14 Oct: only Quest has this (Navigator's
  9 Nov lines are an 88-day transit from 13 Aug that merely coincides with a
  due date). One ship, one order: recorded, not coded. **Explorer** — the 12
  waste boxes on PO229591RCL are missing; Ray is tracing them with Hellmann
  and keeps the line open as pending. The email counts them and says
  "overdue since 12 Sep"; 18 aboard at 3 a month, so no stockout turns on it.
  Answered 14 Oct (evening): the five usage rows are transfers out ("10 cases
  transferred to Legend"; "most of the above is related to transfers, which
  the other ship accepts the order on OBP"); Silhouette radiant "has been sent
  to IT for review". He attached "Novembers numbers up to today": measured as
  October 1–14 month-to-date (Beginning = September Ending on 2,360 of 2,369
  rows), so NOT loaded; the complete October file is still expected in the
  first week of November. Quest: "order is updated to 12/18/2026" — the 14 Oct
  CSV still shows 8 Dec on the 11 lines; verify 19 Oct. Side findings in his
  file: Legend 8.5x11 at 0 on 14 Oct, as the 12 Oct email said; Grandeur 11x17
  and Millennium radiant are rows the statistic has lost (Ending 0, live 33
  and 10) — usage 0 falls to the average, nothing to fix.
  Still open: the October export (first week of November); Silhouette radiant
  with IT.
