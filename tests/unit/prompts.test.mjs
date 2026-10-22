// Goal prompts are worked out from the live ledger (pure functions shared with the home page).
import { test } from "node:test";
import assert from "node:assert/strict";
import { goalPrompts, giftImpact, nextGoal, suggestedAmounts } from "../../public/assets/js/prompts.js";

const L = (over = {}) => ({
  milestones: [{ amount: 10000, title: "Attorney" }, { amount: 2000000, title: "Park" }],
  totals: { received: 3000, outstandingPledges: 1000 },
  limits: { minGift: 5, maxGift: 1000, allowPlans: true, maxPlanPayments: 12, suggestedAmounts: [25, 50, 100, 250] },
  goal: { promptsEnabled: true, headline: "", deadline: null }, plans: { active: 0, monthly: 0 },
  areas: [{ area: "Magnolia Point", received: 2000 }, { area: "Whitfield", received: 500 }], ...over,
});

test("the next goal is the first one not yet reached, whatever order they were entered in", () => {
  assert.equal(nextGoal([{ amount: 2000000, title: "Park" }, { amount: 10000, title: "Attorney" }], 3000).title, "Attorney");
  assert.equal(nextGoal([{ amount: 10000, title: "A" }], 10000), null);
  assert.equal(nextGoal([{ amount: 10000, title: "A" }, { amount: 50000, title: "B" }], 12000).remaining, 38000);
});
test("prompts state the gap, pledges in hand, gifts needed, a plan option and the leading area", () => {
  const p = goalPrompts(L());
  assert.equal(p.headline, "Help reach “Attorney”");
  const t = p.lines.join("\n");
  assert.match(t, /\$7,000 to go to reach “Attorney” \(goal 1 of 2, \$10,000\)/);
  assert.match(t, /\$1,000 is already pledged\. When every pledge is paid, we'll be 40% of the way there\./);
  assert.match(t, /60 more neighbors giving \$100 would close the gap/);            // (7000 - 1000) / 100
  assert.match(t, /Or 40 neighbors giving \$25 a month for 6 months/);             // 6000 / 150
  assert.match(t, /Magnolia Point leads with \$2,000 received\. Whitfield is \$1,500 behind\./);
});
test("plan pace and a target date add their own lines", () => {
  const now = Date.parse("2026-10-17T12:00:00");
  const p = goalPrompts(L({ plans: { active: 3, monthly: 300 }, goal: { promptsEnabled: true, headline: "Hire the attorney", deadline: "2026-10-26" } }), { now });
  const t = p.lines.join("\n");
  assert.equal(p.headline, "Hire the attorney");
  assert.match(t, /3 giving plans bring in \$300 a month; at that pace alone the goal is 20 months away/);
  assert.match(t, /To get there by October 26, 2026: \$700\.00 a day for 10 days/);
  assert.ok(!/a day for/.test(goalPrompts(L({ goal: { promptsEnabled: true, deadline: "2020-01-01" } }), { now }).lines.join()), "a past date is ignored");
});
test("prompts can be switched off, and celebrate when every goal is met", () => {
  assert.equal(goalPrompts(L({ goal: { promptsEnabled: false } })), null);
  const done = goalPrompts(L({ totals: { received: 2500000 } }));
  assert.equal(done.goal, null); assert.match(done.lines[0], /passed its largest goal, \$2,000,000/);
});
test("suggested amounts respect the limits; the impact line works for one gift and for a plan", () => {
  assert.deepEqual(suggestedAmounts({ minGift: 30, maxGift: 200, suggestedAmounts: [250, 25, 50, 100, 50] }), [50, 100]);
  assert.deepEqual(suggestedAmounts({}), [25, 50, 100, 250, 500, 1000]);
  assert.equal(giftImpact(L(), 70), "$70.00 is 1.0% of what's still needed for “Attorney”.");
  assert.equal(giftImpact(L(), 25, { payments: 6 }), "6 payments of $25.00 = $150.00, 2.1% of what's still needed for “Attorney”.");
  assert.match(giftImpact(L(), 7000), /enough to reach it/);
  assert.equal(giftImpact(L(), 0), "");
});
