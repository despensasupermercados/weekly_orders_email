# How Ray decides what a ship orders — the model behind the Monday email

Kept in the repo because a session depends on it (Miguel, 14 Oct 2026: "keep
in the brain all you have been learning from Ray … learn the logic behind").
The Brain holds the same model (recgdbUC2oXqQD3Nl, linked to Ray Guerra,
CIMS Inventory Reporting and this repo) and Ray's usage statement as a
correction on his subject (recos9rpgrWV2vKIo). Dates are 2026 unless marked.
Sources: Ray's written answers of 1 Sep (Q19–Q22) and 4 Sep (Q1, Q7, Q8); his
emails of 24–25 Sep; his review of the 12 Oct email (`email stats
10122026.xlsx`); his marked sample of 13 Oct (`Ray method sample 12 Oct 2026
RG.xlsx`, 2 Y / 24 N, Q1–Q5); his September OBP export of 14 Oct; his email
answers of 14 Oct, and his evening reply the same day with the October-to-date
files. Every quote below is verbatim. Where each piece lives in the Brain is
in §8; the master record there carries the same rules with the WHY behind
each, so another app asking the Brain gets the reason, not only the rule.

## 1. The logic, in one paragraph

Ray plans each ship forward from **last month's usage**, counts **every
delivery already ordered** (late ones included), and acts when the stock will
**drop below a month of usage before the next delivery lands**: "It becomes a
concern when the paper drops below the usage level, which then it becomes an
emergency depending when next order is expected to arrive." He does **not**
hold a fixed spare at month end; shown 26 rows built on that idea he struck
24 ("current order projections do not affect paper usage"). Paper moves in
**pallets of 40 cases**, sized on last month. Print-shop toner is ordered on
**consumption plus a spare: 3 where delivery comes within the month, 4 on a
long-haul itinerary**. **Azamara is kept lean on purpose** and topped
up as needed, with **zero tolerance** for a toner at nil. MFD toner and waste
bottles follow the **OBP par**. He trusts **OBP's own usage figure**, which on
about 1% of rows is lower than the arithmetic of its counts. He reads the
**due date** as the deadline: after it the order "is processed or it's missed".

## 2. The rules, each with its source and where it lives in the code

| Rule | Ray's words | When | Code |
|---|---|---|---|
| Usage = last month's consumption (paper, radiant, print-shop toner) | "the usage used was from last month, then the statistics shows what is expected to be ordered in the coming months. subject to change based on actual consumption." | 12 Oct | `runwayDb.js` `RATE`; email "we plan on last month" |
| A zero month → plan on the average | "correct" (Q3, Quest WX-103: 2, 2, then 0) | 13 Oct | `RATE` = `COALESCE(NULLIF(lastm,0), avg)` |
| Floor-model toner and waste bottles plan on six months | asked whether TN324, TN514, TNP75, TNP79, TN-328 and WX-103 should plan on the 6-month average while paper and C4070 toner stay on last month: "yes. six month average would work better for the floor models toners." | 22 Oct | `runwayDb.js` six-month window (`FLOOR_MODEL_MONTHS`, `isFloorModel`); email "we plan on the 6-month average"; falls back to last month without seven month-end counts |
| OBP's usage figure over our computed one | the September export, one sheet per ship | 14 Oct | `weekly_obp_consumption`; email "(OBP)" |
| Every ordered delivery counts, late ones too | Oasis, 40 cases due 11 Oct still in transit: "no paper order required" | 12 Oct | `transit` CTE, late = today; email "overdue since" |
| Act when the shelf empties before the next delivery the open order could beat | Q4 above | 13 Oct | `runsOutFirst` (PR #35, #39) |
| No month-end spare; no pallet for a small shortfall months out | 24 of 26 N; "current order projections do not affect paper usage" | 13 Oct | not built, on purpose |
| Paper in sets of 40, sized on last month | "always ordered in a pallet of 40 cases" (Q19); "paper is ordered in sets of 40 cases based om previous months consumption" (Q1) | 1 Sep, 13 Oct | `PAPER_PALLET = 40` |
| Azamara paper is strict consumption, no pallets | "based on strict consumption due to space so they could not accept 40 cases rather what they use" (Q19) | 1 Sep | `orderQuantity` Azamara branch |
| Radiant white: minimum 10, more if needed | "minimum of 10 cases … if a ship needs 14 cases, they can order the 14" (Q20, Q8) | 1 Sep, 4 Sep | `RADIANT_MIN = 10` |
| Print-shop toner: consumption plus a spare | "order 3 toners over their consumption amount … a safety net in case you print a little bit more" (Q20) | 1 Sep | `orderQuantity` toner branch |
| The spare is 3 at home, 4 long-haul | "USA ships have a 3+ rule and international ships have a 4+ rule, if a ship is leaving the USA, you will normally start processing their international orders -3 months in advance, which already has to have the 4+ rule. if the ship is returning to USA, the 3+ rule will come into play when they do their first order here, allowing them to adjust to new consumption." | 15 Oct | `tonerSpare()`, from the order's loading port and the next one |
| "International" means long-haul, not the flag | "Vancouver is considered international but since its next to the USA, it gets delivered within the month. ST MAARTEN, ORANJESTAD, FREEPORT, PUNTARENAS is also considered international but again nearby so the delivery once a month works. Canada, Caribbean Islands deliver on a shorter timeframe than other international sectors." | 7 Sep | `deliveryClass()`: US, Canada, Caribbean +3; Europe, Asia, Australia, South America +4 |
| The last US order before leaving takes +4 | "The last US order before the ship goes international takes +4; the first order on return to the US takes +3" (Sep spec, recJFeQFxD78KCbaX) | 8 Sep | `tonerSpare()`: +4 when the next loading is long-haul |
| Azamara toner spare is a flat +3 | "+3 Azamara (exception cruise line, flat)" (Sep spec) | 8 Sep | `tonerSpare()` Azamara branch; not re-confirmed on 15 Oct |
| HON plans on last month too; the average is for dry dock and quiet months | "for the HON, i would recommend using the last month number only and guide the adjustments for the future based on that. the average should be viewed more for dry dock or quite months as the usage can pickup at any time" | 15 Oct | cims-hon to change; the email already shows the average beside last month and plans on it when last month is zero |
| Waste box (C4070): the order is 12, 24 on high volume | "the exact order is 12 pieces per ship from all brands" (Q7); round 8: "12 pieces per order no exceptions"; "12 base, 24 permitted on high volume"; 27 Oct, on Star's "Add 5": "System is still not understanding the 12 piece rule for waste toners" | 4 Sep, 27 Oct | `WASTE_BOX_ORDER = 12`, the order quantity when the box is needed, never a top-up (a session read it as a par 10 Sep–27 Oct) |
| An item that lasts past the landing after the open order waits for that order | 13 Oct, paper rows struck: "current order projections do not affect paper usage"; 27 Oct, Radiance paper and Star waste box with nothing coming: "Vessel has enough ... for November but needs to put order in December" | 13 Oct, 27 Oct | `runway.js` `runsOutFirst`: `orderLands < out` and `out > orderUntil` → silent, whether or not a delivery is already coming (until 27 Oct only when one was) |
| MFD toner and bottles: top up to the OBP par | "they have a par level assigned on OBP, we follow this par level and replenish only as needed" (Q1) | 4 Sep | MFD branch of `orderQuantity` |
| Azamara holds little by design; top-ups as needed | "inventory cost goes up and some products move very slowly" | 24 Sep | top-ups appear as in-transit lines outside the schedule |
| Azamara toner tolerance is zero days | "Days without item 0 … if item drops to 0, printer needs to communicate immediately" | 25 Sep | red line "If you cannot wait, tell your Inventory Manager now" |
| The due date is the deadline | "looks at the order due date which is the physical date they have to process the order or it's missed. After that … the loading delivery date which is the date that the items are gonna be on board" (Q21) | 1 Sep | `open_order` = earliest due ≥ today; two tiles |
| A missed order goes through the Inventory Manager as a manual order | Q22 | 1 Sep | "ask your Inventory Manager to check the next due date" |
| Crew adds; IM confirms the date; Ray approves and buys | Miguel, "the inventory manager is a guide, Ray is the boss" | 16 Sep | email never tells a printer to raise an order |
| Twice-monthly ships: a pallet each order, keep ≥ 40 aboard | "Wonder orders twice a month in sets of 40 cases … stays with a minimun of 40 cases till next orders arrive" (Q5) | 13 Oct | not coded; the pipeline rule covers it |
| Pipeline depth: local 3 months, international 6 | "local vessels are 3 months orders while international ships hold 6 months of orders" (Q2) | 13 Oct | not coded |
| Ships in transition use less | Brilliance "repositioning to USA, paper is adequate"; Legend "will need paper even during the transition to USA at lower usage" | 13 Oct | not coded; shows in last month's figure |
| No fixed lead time for a manual order | — | 16 Sep | the email never invents a date |
| There is no 28-day rule | he was reading our own line back to us | 24 Sep | nothing |

## 3. What Ray rejected, and what that tells us

- **Month-end spare stock** (one month of usage on board at each month end,
  ~3 months ahead). 24 of 26 sample rows N. Yet two of his own marks are that
  method: Legend +40 "to balance usage in November" and Jewel +40 (12 Oct).
  His rule is not a formula; it is "will it run short before the next
  delivery", judged with context we cannot see (repositioning, emergency
  top-ups, a ship about to switch paper).
- **Re-ordering on top of an emergency top-up.** Spectrum cyan: "overage due
  to emergency request". A recent emergency delivery means the next order is
  smaller, not bigger.
- **The higher-of-two usage rule** we had quoted back to him as his SOP. His
  sheets use last month on 42 of 44 rows; he struck the two rows the higher
  figure produced (Solstice radiant, Freedom yellow).
- **Our print-shop toner quantity** (one cycle + 3, ignoring stock aboard at
  landing). Freedom yellow: we said 6, he said 0 with 14 aboard. Spectrum: we
  said 21, his method 9. The +3 is his; the base is not yet his. Open.
- **Planning floor-model toner on last month (19 Oct, spot check).** Asked to
  check five ships of the 19 Oct email, he called 14 Azamara floor-model rows
  okay ("consumption is okay"; Quest "vessel will be USA in December, to be
  restocked if required"). His "Average usage" column reads about 1 a month
  per item; the email had planned on OBP's last month, 2 to 5. He confirmed
  the five real gaps the email had (Pursuit TNP75, TN324BK at more than 2 a
  month; Onward waste box, TN-328C, TN-328M) and added none: "Based on
  consumption changes, we may need to order some floor model toners for 2
  ships, we can target that at end of month based on final usage." Settled
  22 Oct (§5.5): floor-model toner now plans on six months.

## 4. Data facts about OBP and the MLS, each proven on data

1. **Our 1st-of-month CSV count = OBP's previous-month ending inventory**
   (44 of 44 rows, 12 Oct; 48 of 48 ships by code, 14 Oct). Kept for good in
   `weekly_obp_month_open`.
2. **OBP's usage = Begin + Additions − End − cases transferred out.**
   September: 400 of 419 consumable rows equal our arithmetic; 5 rows lower
   with every input equal. Ray, 14 Oct, on Ascent 8.5x11 (49 → 39), Brilliance
   11x17 and 8.5x11, Constellation 11x17: "10 cases transferred to Legend";
   "most of the above is related to transfers, which the other ship accepts
   the order on OBP." The receiving ship books the transfer as an Addition
   (Legend's September Additions, 60, carry them). Silhouette radiant
   (16 → 1): "IT will be checking this one … Silhouette is an issue and has
   been sent to IT for review." Our own formula overstates a sender's usage by
   the transfer; Ray's export is the source (Brain recg5ns8T9RAGYj0G).
3. **Receipts in the old workbook mirror were incomplete** (Quest ×11,
   Spectrum, Infinity). The CSV `acceptedorderdetails` is right.
4. **A receipt can be booked before the shelf rises.** Infinity yellow: 8
   booked received 28 Sep, on the shelf 6 Oct. A month boundary between the
   two inflates one month and deflates the next.
5. **An in-transit ETA can be the order's due date, not its landing.** Quest:
   11 lines with ETA 8 Dec are on board 18 Dec (Ray). Only Quest, 14 Oct.
6. **A late line can be lost, not late.** Explorer's 12 waste boxes
   (PO229591RCL, dated 12 Sep) are missing with Hellmann; Ray keeps the line
   open. We count it and print "overdue since".
7. **The Azamara MLS has long leads that are real.** Quest due 19 Oct → on
   board 7 Feb; due 8 Dec → 18 Dec; due 18 Dec → 5 Jan. All as published.
8. **OBP sheet codes** (September export): JR Journey, OW Onward, PR Pursuit,
   QS Quest; AD Adventure, AL Allure, AN Anthem, BR Brilliance, EN
   Enchantment, EX Explorer, FR Freedom, GR Grandeur, HM Harmony, IC Icon, ID
   Independence, JW Jewel, LE Legend, LB Liberty, MA Mariner, NV Navigator,
   OA Oasis, OY Odyssey, OV Ovation, QN Quantum, RD Radiance, RH Rhapsody, SR
   Serenade, SC Spectrum, ST Star, SY Symphony, UT Utopia, VI Vision, VY
   Voyager, WN Wonder; AX Apex, AT Ascent, BY Beyond, CS Constellation, EC
   Eclipse, EG Edge, EQ Equinox, IN Infinity, ML Millennium, RF Reflection,
   SI Silhouette, SL Solstice, SM Summit, XC Xcel; HE Hero (not in service).
9. **Ray's "had X cases" = our 1 Oct count** on 22 of 22 rows: we and he
   start from the same shelf; disagreements are about usage and judgement.
10. **A file Ray calls "Nov start" is October to date.** 14 Oct, evening:
    "Novembers numbers up to today are attached" = AZA / Royal / CEL "Nov start
    OBP.xlsx". Beginning = September's Ending on 2,360 of 2,369 rows; usage
    about 45% of September's (14 of 30 days). A month in progress is never
    loaded as a planning month (on 1 Nov it would become the rate), so these
    stayed out of `weekly_obp_consumption`. The complete October file, first
    week of November, is the one to load.
11. **The statistic loses rows.** Beginning > 0, Ending 0, Usage 0 while OBP's
    live count is > 0: Grandeur 11x17 (statistic 0, live 33 on 14 Oct),
    Millennium radiant white (statistic 0 in September and October, live 10).
    Not a transfer, not a dry shelf. Usage 0 falls to the trailing average by
    the zero rule in `runwayDb.js` (`COALESCE(NULLIF(lastm, 0), avg3)`), and
    the stock walk uses the live count, so neither the rate nor the shelf is
    misread. Do not "fix" such a row at load time.
12. **The engine's Legend call held.** 12 Oct email: Legend 8.5x11, 2 cases,
    44 a month, dry 14 Oct, 40 landing 22 Oct. OBP's statistic on 14 Oct:
    Beginning 23, Ending 0, Usage 23; live count 1.
13. **On floor-model toner, OBP's month figure and the counts can disagree.**
    Quest TN324BK, September: OBP's export says 4 used; the counts say 1
    (4 aboard end of August + 2 received − 5 aboard end of September). At 1
    or 2 a month one such month is the whole signal. Found on 19 Oct;
    settled with §5.5 on 22 Oct: floor-model items plan on six months of
    counts, where one such month cannot dominate.
14. **Ray's month columns are deliveries beside the day's count, not stock
    added to it.** 19 Oct spot check, Onward: his "Oct-26" column (TNP75 2,
    TN-328K 3, 11x17 20, 8.5x11 17) was received on 6 Oct and is inside the
    19 Oct counts. Asked whether he had added it on top, 22 Oct: "the count
    was never 4, the count was capture from that date and historical number
    of deliveries for the upcoming months". His Current Inventory is the count
    on the day; the month columns show the deliveries, past and coming, beside
    it. Our concern was unfounded.
15. **The 19 Oct replay matches production.** The repo's `fleetRunway` on the
    19 Oct data gives 26 rows; the email's subject said "27 to fix" (26 + 1
    with no schedule).

## 5. Contradictions the Brain still carries — for Miguel to settle

1. **Usage rule — SETTLED 15 Oct.** Ray: "for the HON, i would recommend
   using the last month number only and guide the adjustments for the future
   based on that. the average should be viewed more for dry dock or quite
   months as the usage can pickup at any time." HON's "greater of last month
   and the 3-month average" (recJFeQFxD78KCbaX) is retired; cims-hon owns the
   change. The email needed none: it plans on last month, prints the average
   beside it, and plans on the average when last month is zero (a dry-dock
   month). A numeric "quiet month" switch was measured and NOT built: last
   month below half the average → the average would add 3 rows to the 12 Oct
   replay, one of them Spectrum cyan, which Ray struck on 13 Oct because its
   average is inflated by an emergency top-up.
2. **Toner buffer — SETTLED 15 Oct.** Ray: "USA ships have a 3+ rule and
   international ships have a 4+ rule". Read with his 7 Sep answer on the five
   ports, "international" means long-haul: Vancouver, St Maarten, Oranjestad,
   Freeport, Puntarenas are international but delivered within the month and
   stay +3. The 7 Sep correction (recO6GtPOyx4uTxYM, recN47v4lrTkjQNpO) was
   right about the principle (delivery frequency) and waited only for the
   ports to be on file; the +3-everywhere code was that wait, not a rule.
   Built 15 Oct from `schedule_order.loading_port` (364 of 366 future orders
   carry one; 38 spellings, all classified).
3. **His own marks.** Legend Y (+40) is a month-end-spare decision; the 24 N
   reject that method; Infinity Y on 13 Oct, "okay with current projected
   orders" on 14 Oct. Treat his marks as judgement, not as a rule set.
4. **"OBP consumption statistic" vs the HON projection engine.** Brain
   recDbvRjsKBigZeoJ ("3-month rolling average, +25%") describes HON's
   engine. OBP's statistic is a reported figure per ship and month. Do not
   conflate them.
5. **Floor-model toner usage — SETTLED 22 Oct.** Rule 1 says last month (12 Oct;
   for HON 15 Oct, "last month number only"). His 19 Oct spot check plans
   Azamara floor-model toner on an average of about 1 (Brain
   recE26GAvkxgfOsbk). Measured the same day with the repo's engine on the
   19 Oct data, changing one thing — floor-model toner and bottles planned on
   the last 6 months (start count + receipts − end count, ÷ 6), paper and
   C4070 toner unchanged:

   | | now (last month) | 6-month, floor-model only |
   |---|---|---|
   | rows in the email | 26 | 18 |
   | Ray's 5 gaps shown | 5 | 5 |
   | rows Ray called okay, still listed | 20 | 12 |
   | new rows anywhere in the fleet | — | 0 |

   Gone: Quest TN324BK, TN324C, TN324M, TN514C, TN514M, TN514Y; Onward
   TN-328K; Pursuit TN324M. Still listed against his "okay": Quest TNP75 (dry
   10 Dec, delivery 18 Dec), Onward TNP75 and TNP79K, and the WX-103 rows,
   which have only four months of counts, so the 6-month figure cannot form
   yet and they stay on the current rule. Planning on his flat 1 instead
   would miss two of his own five gaps (Onward TN-328C, TN-328M), which he
   flagged on the August–September jump; a 6-month window still sees it.
   One sample, 25 rows, one week: a replay of 12 Oct was the second check
   before building.

   Ray, 22 Oct, asked the question: "yes. six month average would work better for the floor models toners."
   Built the same day: floor-model toner and bottles plan on the six-month
   count figure, paper and C4070 toner stay on last month. Checked by replay
   before merging:
   - 19 Oct data: identical to the measurement above (18 rows).
   - 12 Oct data: 28 rows → 21, no new row; the 7 that drop are all Azamara
     floor-model rows he called okay on 19 Oct; every paper and C4070 row is
     unchanged, so nothing he kept on 12 Oct is lost.
   - 22 Oct live data (preview of Monday 26 Oct): 29 → 21, no new row; his 5
     gaps all still show (Pursuit TNP75 more urgent: dry 9 Nov, not 22 Nov);
     the 13 paper and C4070 rows unchanged.
   Without seven month-end counts (WX-103 today) or when the window nets to
   zero or less, an item stays on last month.

## 6. Open with Ray (14 Oct, evening; updated 22 Oct)

Answered 22 Oct: floor-model toner on six months (§5.5, built); his month
columns are deliveries beside the day's count (§4.14).

- The complete October export in the first week of November. He sent October
  to date on 14 Oct under the name "Nov start" (§4.10); the ask is re-stated
  in the reply drafted the same evening.
- Quest's 11 lines (70 units, ordered 8 Oct): "order is updated to
  12/18/2026". DONE 19 Oct: the export reads 18 Dec (Brain reckf7iZlrCvHgXrc).
- Silhouette radiant white: with IT on his side. Nothing to ask until IT
  answers; the engine plans on OBP's 1, which matches his own judgement.
- Azamara's toner spare: the September spec says a flat +3; his 15 Oct answer
  did not mention Azamara. Ask only if an Azamara toner quantity is disputed.
- Azamara paper tolerance (ask only when a paper gap on Azamara is called fine).

Answered 14 Oct: what OBP subtracts on the five rows (§4.2, transfers out).

### Shared with other apps (16 Oct)

Miguel, 16 Oct: the settled rules "should be cross pollinated to the Brain and
across the apps that use it". The weekly email now publishes them every night
into `weekly_ordering_rules` in the shared D1 database (`src/lib/orderingRules.js`):
usage basis, the toner spare (+3, +4, leaving and returning, Azamara flat +3,
unknown port), paper, radiant white, waste box, MFD par, and every port with
its delivery class. Values come from the same functions the email runs, so the
table cannot disagree with the email. Other apps read it; none keeps a copy.

HON (cims-hon) still runs the old usage and buffer. Push access to cims-hon was
refused on 16 Oct, so the change is written as a brief with a paste-in prompt:
`docs/cims-hon-ordering-rules-handoff-2026-10-16.md`. The INV_04 and INV_06
canonical docs need the same update; they sit with cims-hon.

## 7. How to work with Ray (standing rules, learned the hard way)

- Nothing goes to Ray that our own data can answer (Brain recZfDnmkCrqfODd3).
- Quote him verbatim; a paraphrase inverted a design question once.
- Show both inputs behind a number; the Infinity "6 vs 11" argument ended the
  moment the inputs were printed.
- A correction he has not taken after two emails goes into the Monday line,
  not a third email.
- Measure his method on real data before building it; the sample workbook
  (26 rows, Y/N) got a clear answer in a day.

## 8. Where this lives in the Brain (Airtable base app2OLcIjn8LgYWW9)

Audited 15 Oct by asking the Brain eight questions another app would ask.
Five came back right, Explorer misrouted, Quest's December dates were absent,
and the toner buffer came back as the HON spec's "+3 USA / +4 international"
with the greater-of usage rule, asserted as fact. Written the same day:

| Subject | Record | Holds |
|---|---|---|
| master (linked to Ray, OBP, Azamara, Quest, Explorer, Legend, Silhouette, MLS) | recgdbUC2oXqQD3Nl | the 21 rules with Ray's words verbatim and the WHY of each; §3–§7 of this file |
| Ray Guerra | recos9rpgrWV2vKIo | usage = last month (12 Oct), zero → average |
| Ray Guerra | recaGgsFr06d19lkW | his 15 Oct answers, verbatim: HON on last month only; +3 home, +4 long-haul, which order carries it, why; supersedes recHQ7zBmxgex5JU4 |
| HON App | recEIkmG8f2bUtmlx | the two HON rules Ray changed, how HON must read `weekly_ordering_rules`, not built yet; supersedes rec5oo0n9yYhLNV8O |
| CIMS Inventory Ordering Logic | recqc78LiXJVT7q9C | every rule in force on 16 Oct, Azamara flat +3 and why, which app runs what |
| Azamara | rec1SHsMoq28vNZoY | the flat +3 toner spare, why, and that Ray has not re-confirmed it |
| Master Loading Schedule (MLS) | recclKCEU98iyK6ey | the loading port sets the spare; port spellings; where to add a new port |
| CIMS Inventory Reporting | recb4DTsdbDHjoYZW | the +4 the 7 Sep records waited for is built (PR #46) |
| Ray Guerra | recA7ZeRI6XXhmk7f | his 14 Oct evening reply, as a log |
| Ray Guerra | rec9FKkMs0RASmUgZ, recLgXfvZjZTvxcNp | 13 Oct marks; Quest and Explorer answers |
| OBP | reczif0KBkKahwxUp | September export, the 49 sheet codes |
| OBP | recg5ns8T9RAGYj0G | usage excludes transfers out; "Nov start" = October to date; lost rows |
| Azamara | recWvxaA9Chii3qlu | lean by design (why), toner tolerance 0 days, the 25 Sep par table, paper tolerance still open |
| Azamara | recfxNc6RGme0dtvM | 22 Oct: floor-model toner plans on six months; Ray's words, why, the formula, the replays. Supersedes recE26GAvkxgfOsbk (19 Oct spot check, archived) |
| Azamara Quest | recY1rlEU9cVTInyV | December dates, ETA = due date, Ray's update |
| Azamara Quest | reckf7iZlrCvHgXrc | the 11 lines read 18 Dec (19 Oct) |
| Azamara Quest | recvgLzaIhBHDVtUZ | 19 Oct: okay until its December–January USA calls; the two risks he names (OBP not updated daily, C4070 down) |
| Azamara Onward | recTCdb4khMZPl5Mw | 19 Oct: waste box, TN-328C, TN-328M need an order; the "Oct-26" column already received (log) |
| Azamara Onward | recCrhMSkmYHf9d9i | 22 Oct: his month columns are deliveries beside the day's count, not added to it (log) |
| CIMS Inventory Ordering Logic | recvtmYPtdlApfYnT | 22 Oct: the usage rules in force, floor-model on six months |
| HON App | recrEauAhYMMZJtBj | 22 Oct: the floor-model item for HON (log) |
| CIMS Brain | reckcPfpDyAI632St | how a session writes to the Brain so the next one finds it (log, 19 Oct) |
| CIMS Inventory Reporting | rechmpDFj9dZc4rnz | the session handoff, READ FIRST; aliases "weekly orders email", "weekly_orders_email" route here (19 Oct) |
| Azamara Pursuit | recuSBO6AOyVhi3Ok | 19 Oct: TNP75 needs an order; TN324BK okay only at 2 a month (log) |
| Legend of the Seas | recJj6S7PV15K9mip | 19 Oct: okay, paper alignment starts 22 Oct (log) |
| Explorer of the Seas | recKGZhsIIfAE56a0 | the 12 waste boxes with Hellmann |
| Legend of the Seas | rec0HBisVxVVkIxN2 | October paper, transfers received, why not a new emergency |
| Celebrity Silhouette | recRwSUI7xXaDDc6g | radiant white: three figures, with IT |
| Grandeur of the Seas, Celebrity Millennium | recBoCAtqmZydti1P, rec02Gc19laa6jEfF | lost rows in the statistic |

Rule for the next session: when Ray teaches something, write it on the
SUBJECT it is about (the ship, OBP, Azamara), in his words, with the why, and
add the record to this table and to §8 of the master record. A fact that only
lives in a log on Ray's record is not found when a ship is asked about.
