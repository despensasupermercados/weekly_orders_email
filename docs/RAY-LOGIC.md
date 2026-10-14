# How Ray decides what a ship orders — the model behind the Monday email

Kept in the repo because a session depends on it (Miguel, 14 Oct 2026: "keep
in the brain all you have been learning from Ray … learn the logic behind").
The Brain holds the same text with record ids. Dates are 2026 unless marked.
Sources: Ray's written answers of 1 Sep (Q19–Q22) and 4 Sep (Q1, Q7, Q8); his
emails of 24–25 Sep; his review of the 12 Oct email (`email stats
10122026.xlsx`); his marked sample of 13 Oct (`Ray method sample 12 Oct 2026
RG.xlsx`, 2 Y / 24 N, Q1–Q5); his September OBP export of 14 Oct; his email
answers of 14 Oct. Every quote below is verbatim.

## 1. The logic, in one paragraph

Ray plans each ship forward from **last month's usage**, counts **every
delivery already ordered** (late ones included), and acts when the stock will
**drop below a month of usage before the next delivery lands**: "It becomes a
concern when the paper drops below the usage level, which then it becomes an
emergency depending when next order is expected to arrive." He does **not**
hold a fixed spare at month end; shown 26 rows built on that idea he struck
24 ("current order projections do not affect paper usage"). Paper moves in
**pallets of 40 cases**, sized on last month. Print-shop toner is ordered on
**consumption plus a spare**. **Azamara is kept lean on purpose** and topped
up as needed, with **zero tolerance** for a toner at nil. MFD toner and waste
bottles follow the **OBP par**. He trusts **OBP's own usage figure**, which on
about 1% of rows is lower than the arithmetic of its counts. He reads the
**due date** as the deadline: after it the order "is processed or it's missed".

## 2. The rules, each with its source and where it lives in the code

| Rule | Ray's words | When | Code |
|---|---|---|---|
| Usage = last month's consumption | "the usage used was from last month, then the statistics shows what is expected to be ordered in the coming months. subject to change based on actual consumption." | 12 Oct | `runwayDb.js` `RATE`; email "we plan on last month" |
| A zero month → plan on the average | "correct" (Q3, Quest WX-103: 2, 2, then 0) | 13 Oct | `RATE` = `COALESCE(NULLIF(lastm,0), avg)` |
| OBP's usage figure over our computed one | the September export, one sheet per ship | 14 Oct | `weekly_obp_consumption`; email "(OBP)" |
| Every ordered delivery counts, late ones too | Oasis, 40 cases due 11 Oct still in transit: "no paper order required" | 12 Oct | `transit` CTE, late = today; email "overdue since" |
| Act when the shelf empties before the next delivery the open order could beat | Q4 above | 13 Oct | `runsOutFirst` (PR #35, #39) |
| No month-end spare; no pallet for a small shortfall months out | 24 of 26 N; "current order projections do not affect paper usage" | 13 Oct | not built, on purpose |
| Paper in sets of 40, sized on last month | "always ordered in a pallet of 40 cases" (Q19); "paper is ordered in sets of 40 cases based om previous months consumption" (Q1) | 1 Sep, 13 Oct | `PAPER_PALLET = 40` |
| Azamara paper is strict consumption, no pallets | "based on strict consumption due to space so they could not accept 40 cases rather what they use" (Q19) | 1 Sep | `orderQuantity` Azamara branch |
| Radiant white: minimum 10, more if needed | "minimum of 10 cases … if a ship needs 14 cases, they can order the 14" (Q20, Q8) | 1 Sep, 4 Sep | `RADIANT_MIN = 10` |
| Print-shop toner: consumption plus a spare | "order 3 toners over their consumption amount … a safety net in case you print a little bit more" (Q20) | 1 Sep | `TONER_BUFFER = 3` (see §5.2) |
| Waste box (C4070): par 12, 24 on high volume | "the exact order is 12 pieces per ship from all brands" (Q7); "12 base, 24 permitted on high volume" | 4 Sep | `WASTE_BOX_PAR = 12`, a top-up |
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

## 4. Data facts about OBP and the MLS, each proven on data

1. **Our 1st-of-month CSV count = OBP's previous-month ending inventory**
   (44 of 44 rows, 12 Oct; 48 of 48 ships by code, 14 Oct). Kept for good in
   `weekly_obp_month_open`.
2. **OBP's usage is not always Begin + Additions − End.** September: 400 of
   419 consumable rows equal; 5 rows lower with every input equal (Ascent
   8.5x11 49 → 39, Brilliance ×2, Constellation 10 lower, Silhouette radiant
   16 → 1). OBP subtracts something its counts do not show. Asked 14 Oct.
   Our own formula overstates those rows; Ray's export is the source.
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

## 5. Contradictions the Brain still carries — for Miguel to settle

1. **Usage rule.** The weekly email: last month (Ray, 12 Oct, in writing).
   The HON monthly-orders spec (Brain recJFeQFxD78KCbaX) and an earlier Ray
   quote ("you have to use the 11.7 over the last six months", Brain
   recvHp3MQe8xYaHdq) say the greater of last month and a trailing average.
   Those were about HON's projection, not this email. Should HON change too?
2. **Toner buffer.** Brain 7 Sep: "+3 at every open port, not a nationality
   rule" (recN47v4lrTkjQNpO). Ray, 13 Oct, on Infinity: "orders of 3 pieces
   per month … plus 4 for being international." The code uses +3 everywhere.
   One question to Ray with Infinity as the case.
3. **His own marks.** Legend Y (+40) is a month-end-spare decision; the 24 N
   reject that method; Infinity Y on 13 Oct, "okay with current projected
   orders" on 14 Oct. Treat his marks as judgement, not as a rule set.
4. **"OBP consumption statistic" vs the HON projection engine.** Brain
   recDbvRjsKBigZeoJ ("3-month rolling average, +25%") describes HON's
   engine. OBP's statistic is a reported figure per ship and month. Do not
   conflate them.

## 6. Open with Ray (14 Oct)

- What OBP subtracts on the five rows of §4.2.
- The monthly export, first week of each month (October's by 7 Nov).
- Correct Quest's 8 Dec ETAs to 18 Dec in OBP.
- The toner buffer: +3 everywhere, or +4 international (§5.2)?
- Azamara paper tolerance (ask only when a paper gap on Azamara is called fine).

## 7. How to work with Ray (standing rules, learned the hard way)

- Nothing goes to Ray that our own data can answer (Brain recZfDnmkCrqfODd3).
- Quote him verbatim; a paraphrase inverted a design question once.
- Show both inputs behind a number; the Infinity "6 vs 11" argument ended the
  moment the inputs were printed.
- A correction he has not taken after two emails goes into the Monday line,
  not a third email.
- Measure his method on real data before building it; the sample workbook
  (26 rows, Y/N) got a clear answer in a day.
