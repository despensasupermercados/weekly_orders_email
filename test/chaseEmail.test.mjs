import assert from 'node:assert/strict';
import { renderChase, chaseSubject, chaseDeadline, WHY, CHASE_HOURS, SCHEDULE_INBOX } from '../src/lib/chaseEmail.js';
import { STATUS } from '../src/lib/scheduleStatus.js';

// Miguel, 17 Sep 2026: one email per ship, Ray in cc, always a 24-hour
// turnaround, mock-up approved. The crew reads a headline, a deadline, three
// steps and the address; their own reason sits in a red box at the top and
// their row is highlighted in the fleet table.
const missing = [
  { ship: 'Solstice', status: STATUS.UNMATCHED },
  { ship: 'Beyond', status: STATUS.NEVER },
  { ship: 'Ovation', status: STATUS.UNREADABLE },
];
const sentAtMs = Date.UTC(2026, 8, 17, 14, 5); // Thu 17 Sep 2026 14:05Z

{
  const d = chaseDeadline(sentAtMs);
  assert.equal(d.iso, '2026-09-18T14:05:00.000Z', 'deadline is exactly 24 hours after the send');
  assert.equal(d.text, 'Friday 18 September, 14:05 UTC');
  assert.equal(CHASE_HOURS, 24, 'the turnaround is 24 hours, never longer');
  assert.equal(chaseSubject('Beyond'), 'Beyond: send your Ordering Schedule file within 24 hours');
}

{
  const html = renderChase({ ship: 'Beyond', missing, sentAtMs });
  assert.ok(/CRUISE INDUSTRY MANAGED SERVICES/.test(html), 'canonical letterhead');
  assert.ok(/BEYOND &middot; WHY WE ARE WRITING/.test(html), 'the red box names the reader');
  assert.ok(html.includes(WHY[STATUS.NEVER]), 'and says why in one sentence');
  assert.ok(/Friday 18 September, 14:05 UTC/.test(html), 'the 24-hour deadline is spelled out');
  assert.ok(html.includes(SCHEDULE_INBOX), 'the address the file goes to');
  assert.ok(/Beyond Ordering Schedule\.xlsx/.test(html), 'the file-name example carries the ship');
  assert.ok(/Beyond <span[^>]*>&larr; you<\/span>/.test(html), 'the reader\'s row is highlighted');
  assert.ok(!/Solstice <span[^>]*>&larr; you/.test(html), 'and only theirs');
  assert.ok(/WAITING FOR &middot; 3/.test(html), 'the table counts every missing ship');
  const order = ['Beyond', 'Ovation', 'Solstice'].map((s) => html.indexOf(`>${s}<`) >= 0 ? html.indexOf(`>${s}`) : html.indexOf(s));
  assert.ok(order[0] < order[1] && order[1] < order[2], 'ships listed alphabetically');
  assert.ok(!/linear-gradient|rgba\(/.test(html), 'Outlook rules: no gradients, no rgba');
  assert.ok(/Ray Guerra/.test(html), 'Ray signs it');
  for (const s of Object.values(WHY)) assert.ok(s.split(' ').length <= 12, `crew line under twelve words: ${s}`);
}

{
  const html = renderChase({ ship: null, missing, sentAtMs });
  assert.ok(!/&larr; you/.test(html), 'the fleet copy highlights nobody');
  assert.ok(!/WHY WE ARE WRITING/.test(html), 'and has no red box');
  assert.ok(/3 ships: send your Ordering Schedule file/.test(html));
}

console.log('ok - chase email: 24-hour deadline, reader\'s reason and row, address, every missing ship listed');
