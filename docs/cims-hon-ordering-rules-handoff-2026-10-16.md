# HON: two ordering rules Ray changed on 15 Oct 2026, and where to read them

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

## 4. Read the rules from D1; never keep a second copy

`weekly_orders_email` publishes the rules every night (06:00 UTC cron) into
`weekly_ordering_rules` in D1 `cims-hon` (`7b4387c8-c611-45f8-a2e8-58061989f833`).
Every value is generated from the code the Monday email runs, so the table
cannot say something that code does not do. First load: 16 Oct 2026, 133 rows.
The table belongs to weekly_orders_email: read it, never write it.

| rule | key | value |
|---|---|---|
| usage | plan_on | last_month |
| usage | zero_month | trailing_average |
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
- Brain: recaGgsFr06d19lkW (Ray's answers), rec5oo0n9yYhLNV8O and the 16 Oct
  record on HON App, recgdbUC2oXqQD3Nl (master model, rules 1 and 10).

## Prompt to paste into a cims-hon session

```
In cims-hon, change the HON monthly orders check to the two rules Ray Guerra
settled on 15 Oct 2026. The full brief, with his words, is in the
weekly_orders_email repo at docs/cims-hon-ordering-rules-handoff-2026-10-16.md.
1) Usage: plan on last month's usage only; show the 3-month average beside it;
   use the average only when last month is zero. Remove "greater of last month
   and the 3-month average". No numeric quiet-month threshold.
2) Print-shop toner spare (TN619/TN634): read it, do not copy it, from D1
   cims-hon table weekly_ordering_rules (owned by weekly_orders_email, read
   only). +3 when the order loads at a 'monthly' port; +4 when the order's
   loading port OR the ship's next loading port is 'long-haul'; Azamara flat +3;
   a port not in the table gets +3 and is flagged. Port key = uppercase letters
   only of schedule_order.loading_port.
3) Add tests for the seven acceptance cases in the brief, fault-inject each
   clause, and replay one real day to list which ships change.
4) Update INV_04 and INV_06 with the new rules, sources and dates.
5) Open a PR, get CI green, then report what changed per ship.
```
