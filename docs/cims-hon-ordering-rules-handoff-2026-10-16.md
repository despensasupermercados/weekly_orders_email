# HON: the ordering rules Ray changed on 15 and 22 Oct 2026, and where to read them

For whoever works on cims-hon (hon.cims.work). This session could not change
cims-hon: push access to that repo was refused on 16 Oct. Everything HON needs
is below, plus a prompt to paste into a cims-hon session at the end.

## What Ray said (verbatim, 15 Oct 2026)

Usage, asked whether HON should follow the weekly email:

> "for the HON, i would recommend using the last month number only and guide
> the adjustments for the future based on that. the average should be viewed
> more for dry dock or quite months as the usage can pickup at any time."

Toner spare, asked whether it is 3 everywhere:

> "USA ships have a 3+ rule and international ships have a 4+ rule, if a ship
> is leaving the USA, you will normally start processing their international
> orders -3 months in advance, which already has to have the 4+ rule. if the
> ship is returning to USA, the 3+ rule will come into play when they do their
> first order here, allowing them to adjust to new consumption."

Read with his 7 Sep answer on five ports (Brain recO6GtPOyx4uTxYM):

> "Vancouver is considered international but since its next to the USA, it
> gets delivered within the month. ST MAARTEN, ORANJESTAD, FREEPORT,
> PUNTARENAS is also considered international but again nearby so the delivery
> once a month works. Canada, Caribbean Islands deliver on a shorter timeframe
> than other international sectors."

So "international" means long-haul. The line is how often a container can
reach the ship, not the flag on the port.

## What HON must change

1. **Usage basis.** Plan on last month's usage. The "greater of last month and
   the 3-month average" in the HON spec (Brain recJFeQFxD78KCbaX) is retired.
   Show the average beside last month as a reference. Plan on the average only
   when last month is zero, which covers a dry-dock month. Do not add a
   numeric "quiet month" threshold. Tested on the 12 Oct replay, "last month
   under half the average, use the average" added 3 rows, one of them Spectrum
   cyan, which Ray struck as an emergency-top-up overage.
2. **Print-shop toner spare (TN619 C/M/Y, TN634 K).**
   - +3 when the order loads at a port delivered within the month (USA, Canada,
     Caribbean islands, the five ports above).
   - +4 when the order loads at a long-haul port (Europe, Asia, Australia,
     South America), or when the ship's NEXT loading is long-haul. That is the
     last US order before it leaves, as the September spec already said.
   - The first order back in the USA, with a US loading after it, is +3.
   - Azamara is a flat +3 ("exception cruise line, flat", September spec).
     Ray did not mention Azamara on 15 Oct. Ask him only if an Azamara toner
     quantity is disputed.
   - A port on neither list: +3, and say the port is not on file.
3. **Do not copy the port lists.** Read them (rule 4).

**Added 22 Oct: floor-model toner plans on six months.** Ray, asked whether
floor-model toner and waste bottles (TN324, TN514, TNP75, TNP79, TN-328,
WX-103) should plan on the 6-month average while paper and C4070 toner stay on
last month: "yes. six month average would work better for the floor models toners." The weekly email does this
from 22 Oct: (count at the end of the month before the six + every receipt −
count at the end of last month) ÷ 6, and last month when the seven month-end
counts are not all on file or the window nets to zero or less. If HON plans
those items, it reads `usage / floor_model_plan_on`, `floor_model_items`,
`floor_model_months` and `floor_model_formula` from `weekly_ordering_rules`
rather than writing its own.

## 4. Read the rules from D1; never keep a second copy

`weekly_orders_email` publishes the rules every night (06:00 UTC cron) into
`weekly_ordering_rules` in D1 `cims-hon` (`7b4387c8-c611-45f8-a2e8-58061989f833`).
Every value is generated from the code the Monday email runs, so the table
cannot say something that code does not do. First load: 16 Oct 2026, 133 rows;
137 from the 23 Oct run (the four floor-model rows).
The table belongs to weekly_orders_email: read it, never write it.

| rule | key | value |
|---|---|---|
| usage | plan_on | last_month |
| usage | zero_month | trailing_average |
| usage | floor_model_plan_on | six_month_average |
| usage | floor_model_months | 6 |
| usage | floor_model_items | MFD toner TN324, TN514, TNP48, TNP75, TNP79, TN-328; MFD waste WX-103, WB-P05, waste toner bottles, "WASTE TONER BOX" without (DG3) |
| usage | floor_model_formula | (count at the end of the month before the 6 + receipts − count at the end of last month) / 6; all 7 month-end counts and a result above 0, else last month |
| toner_spare | monthly | 3 |
| toner_spare | long-haul | 4 |
| toner_spare | leaving_usa | 4 |
| toner_spare | returning_usa | 3 |
| toner_spare | azamara | 3 |
| toner_spare | unclassified_port | 3 |
| port_class | (port key) | monthly or long-haul |

Port keys are the port name in uppercase letters only: `VENICE (RAVENNA)`
becomes `VENICERAVENNA`, `Port Everglades` becomes `PORTEVERGLADES`. The
loading port of each order is `schedule_order.loading_port`.

```sql
-- the spare for one order: its port and the ship's next loading port
SELECT COALESCE(MAX(CASE WHEN value = 'long-haul' THEN 1 END), 0) AS long_haul
  FROM weekly_ordering_rules
 WHERE rule = 'port_class' AND key IN (?1, ?2);   -- ?1 this port key, ?2 next port key
SELECT key, value FROM weekly_ordering_rules WHERE rule IN ('toner_spare', 'usage');
```

## Acceptance checks (the same cases the weekly email's tests pin)

| Case | Order loads | Next loading | Spare |
|---|---|---|---|
| US order, US next | PORT EVERGLADES | PORT EVERGLADES | 3 |
| Last US order before Europe | PORT EVERGLADES | CIVITAVECCHIA | 4 |
| Order abroad | BARCELONA | BARCELONA | 4 |
| Last order abroad before the USA | VENICE (RAVENNA) | PORT EVERGLADES | 4 |
| First order back, US next | PORT EVERGLADES | MIAMI | 3 |
| Azamara anywhere | Singapore | Busan | 3 |
| Port not on file | ENSENADA | LOS ANGELES | 3, flagged |

Ships at +4 on 15 Oct 2026: Anthem, Edge, Equinox, Infinity, Millennium,
Navigator, Quantum, Spectrum. The September spec's own list of ships at +4
for the whole window was Edge, Equinox, Infinity, Millennium, Solstice and
Spectrum, which agrees.

## Also update the canonical docs

INV_04 (ordering formulas as built) and INV_06 (corrections log) still carry
the greater-of usage rule and the "+3 everywhere until the ports are parsed"
reading. Update both in the same shape the series uses: the fact, its named
source, the date, and what it supersedes.

## Where else this is written

- `docs/RAY-LOGIC.md` (rules table and section 5), `docs/DECISIONS.md` (15 Oct
  entries), `src/lib/runway.js` (`deliveryClass`, `tonerSpare`),
  `src/lib/orderingRules.js` (the published table).
- Brain: recaGgsFr06d19lkW (Ray's answers), recEIkmG8f2bUtmlx (HON App, this
  change), recqc78LiXJVT7q9C (rules in force), rec1SHsMoq28vNZoY (Azamara flat
  +3), recclKCEU98iyK6ey (loading ports), recgdbUC2oXqQD3Nl (master model).

## Prompt to paste into a cims-hon session

Updated 22 Oct with the floor-model rule. Self-contained: a cims-hon session may not
be able to read this repo.

```
Update HON (cims-hon, hon.cims.work) to the ordering rules Ray Guerra (DG3 Supply Chain Manager) settled on 15 and 22 Oct 2026. The weekly orders email (repo weekly_orders_email) already runs them; HON must give the same answers.

READ FIRST, CHANGE SECOND
0) Find in the code what HON plans usage on today and how it sizes toner. Its spec says "greater of last month and the 3-month average", and the Brain (recDbvRjsKBigZeoJ) describes a "3-month rolling average +25%". Report what the code actually does before you change it.

THE RULES (Ray's words in quotes)
1) USAGE = LAST MONTH, for paper, radiant white and print-shop toner (TN619, TN634). Ray, 15 Oct: "for the HON, i would recommend using the last month number only and guide the adjustments for the future based on that. the average should be viewed more for dry dock or quite months as the usage can pickup at any time."
   - Plan on last month's usage. Show the 3-month average beside it, for reference only.
   - Plan on the average only when last month reads zero. That covers a dry-dock month.
   - Remove "greater of last month and the 3-month average".
   - Do not add a numeric "quiet month" threshold. It was measured, and it brought back a row Ray had struck.

2) FLOOR-MODEL TONER PLANS ON SIX MONTHS. This covers MFD toner and waste bottles: TN324, TN514, TNP48, TNP75, TNP79, TN-328, WX-103, WB-P05, waste toner bottles, and "WASTE TONER BOX" without "(DG3)". It does NOT cover the C4070 "WASTE TONER BOX (DG3)" or TN619/TN634. Ray, 22 Oct: "yes. six month average would work better for the floor models toners."
   - Rate = (count at the end of the month before the six + every receipt in the six − count at the end of last month) / 6, from consumption_snapshot.
   - Example for October: (end-of-March count + receipts April to September − end-of-September count) / 6.
   - Use it only when all 7 month-end counts are on file and the result is above 0. Otherwise use rule 1.
   - Why: these items move 1 or 2 a month, so one month is noise. Quest TN324BK, September 2026: OBP said 4 used, while the counts said 1 (4 aboard + 2 received − 5 aboard).
   - The order quantity does not change: top up to the OBP par.

3) PRINT-SHOP TONER SPARE (TN619 C/M/Y, TN634 K) = consumption + spare. Ray, 15 Oct: "USA ships have a 3+ rule and international ships have a 4+ rule, if a ship is leaving the USA, you will normally start processing their international orders -3 months in advance, which already has to have the 4+ rule. if the ship is returning to USA, the 3+ rule will come into play when they do their first order here, allowing them to adjust to new consumption." "International" means long-haul, judged by how often a container reaches the ship, not by the flag on the port. Vancouver, St Maarten, Oranjestad, Freeport and Puntarenas get +3.
   - +3 when the order loads at a 'monthly' port.
   - +4 when the order's loading port OR the ship's next loading port is 'long-haul'.
   - Azamara is a flat +3 on every itinerary.
   - A port not in the table gets +3, and the output says it is not on file.

DO NOT COPY ANY OF THIS: READ IT
4) weekly_orders_email publishes every rule above, every night at 06:00 UTC, into the D1 table weekly_ordering_rules. It sits in the cims-hon database (7b4387c8-c611-45f8-a2e8-58061989f833), and from the 23 Oct run it has 137 rows (133 before). The table belongs to weekly_orders_email: READ IT, NEVER WRITE IT, never keep a second copy of the port lists.
   SELECT key, value FROM weekly_ordering_rules WHERE rule IN ('usage','toner_spare');
   SELECT key, value FROM weekly_ordering_rules WHERE rule = 'port_class';   -- 'monthly' or 'long-haul'
   - Port key = schedule_order.loading_port in uppercase letters only: "VENICE (RAVENNA)" -> VENICERAVENNA, "Port Everglades" -> PORTEVERGLADES.
   - Usage keys: plan_on, zero_month, floor_model_plan_on, floor_model_items, floor_model_months, floor_model_formula.

PROVE IT
5) Tests, at least these cases.
   Toner spare:
   - Order at PORT EVERGLADES, next loading PORT EVERGLADES: 3.
   - Order at PORT EVERGLADES, next loading CIVITAVECCHIA: 4.
   - Order at BARCELONA, next loading BARCELONA: 4.
   - Order at VENICE (RAVENNA), next loading PORT EVERGLADES: 4.
   - Order at PORT EVERGLADES, next loading MIAMI: 3.
   - Azamara, Singapore to Busan: 3.
   - Order at ENSENADA, next loading LOS ANGELES: 3, flagged as not on file.
   Usage:
   - A floor-model item with OBP last month 4 and six months of counts giving 1 plans on 1.
   - Paper plans on last month.
   - TN619 plans on last month.
   - The C4070 waste box plans on last month.
   - A floor-model item with only 4 month-end counts, or a month missing inside the window, plans on last month.
   - A floor-model item whose window nets to 0 or less plans on last month.
   - A zero last month plans on the 3-month average.
   Then break each guard on purpose and confirm a test fails.
6) Replay one real day, old code against new code, and list every ship and item whose number changes. In the weekly email the same change took the fleet list from 29 rows to 21 on 22 Oct data. All 8 rows that dropped were Azamara floor-model rows Ray had called okay; every paper and C4070 row stayed the same, and no new row appeared. HON should move the same way.

FINISH
7) Update the canonical docs INV_04 (ordering formulas as built) and INV_06 (corrections log). They still carry the greater-of rule and "+3 everywhere". For each change, record the fact, its source (Ray, with the date), and what it supersedes.
8) Open a PR and get CI green. After merging, prove it on the deployed Worker, not by reading the code. Then record what shipped in the Brain on HON App (it supersedes the open items in recEIkmG8f2bUtmlx and recrEauAhYMMZJtBj).
9) Report to Miguel in plain words: what HON did before, what it does now, and which ships and items change.

Do not touch weekly_orders_email, its weekly_* tables, or the obp@cims.work routing rule.
```
