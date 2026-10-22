// Goal prompts: plain-language targets worked out from the live ledger, so the page always says
// what it will take to reach the next goal. Pure functions (no page access) so they can be tested.
const usd0 = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const usd = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DAY = 86400000;

/** The first goal not yet reached, or null when every goal is met. */
export function nextGoal(milestones, received) {
  const ms = [...(milestones || [])].filter((m) => Number(m.amount) > 0).sort((a, b) => a.amount - b.amount);
  const i = ms.findIndex((m) => Number(m.amount) > received);
  return i < 0 ? null : { ...ms[i], index: i, count: ms.length, remaining: Math.round((Number(ms[i].amount) - received) * 100) / 100 };
}

/** Suggested amounts that fit the treasurer's limits, smallest first. */
export function suggestedAmounts(limits = {}) {
  const min = Number(limits.minGift) || 1, max = Number(limits.maxGift) || 2000000;
  const list = (Array.isArray(limits.suggestedAmounts) && limits.suggestedAmounts.length ? limits.suggestedAmounts : [25, 50, 100, 250, 500, 1000])
    .map(Number).filter((a) => a >= min && a <= max);
  return [...new Set(list)].sort((a, b) => a - b);
}

/** Builds the headline and the list of targets. Returns null when the treasurer has switched prompts off. */
export function goalPrompts(ledger, { now = Date.now() } = {}) {
  if (!ledger || ledger.goal?.promptsEnabled === false) return null;
  const t = ledger.totals || {};
  const received = Number(t.received) || 0, pledged = Number(t.outstandingPledges) || 0;
  const goal = nextGoal(ledger.milestones, received);
  if (!goal) {
    const top = [...(ledger.milestones || [])].sort((a, b) => b.amount - a.amount)[0];
    return { headline: ledger.goal?.headline || "Every goal has been reached", goal: null,
      lines: [top ? `The fund has passed its largest goal, ${usd0(top.amount)}. Thank you, neighbors.` : "Thank you, neighbors."] };
  }
  const lines = [];
  const amounts = suggestedAmounts(ledger.limits);
  const mid = amounts.length ? amounts[Math.min(amounts.length - 1, Math.floor(amounts.length / 2))] : 100;
  const small = amounts[0] || 25;
  lines.push(`${usd0(goal.remaining)} to go to reach “${goal.title}” (goal ${goal.index + 1} of ${goal.count}, ${usd0(goal.amount)}).`);
  if (pledged > 0) {
    const pct = Math.min(100, Math.floor(((received + pledged) / goal.amount) * 100));
    lines.push(`${usd0(pledged)} is already pledged. When every pledge is paid, we'll be ${pct}% of the way there.`);
  }
  const gap = Math.max(goal.remaining - pledged, 0) || goal.remaining;
  lines.push(`${Math.ceil(gap / mid).toLocaleString("en-US")} more neighbors giving ${usd0(mid)} would close the gap.`);
  if (ledger.limits?.allowPlans) {
    const months = Math.min(Number(ledger.limits.maxPlanPayments) || 12, 6);
    lines.push(`Or ${Math.ceil(gap / (small * months)).toLocaleString("en-US")} neighbors giving ${usd0(small)} a month for ${months} months.`);
  }
  const plans = ledger.plans || {};
  if (Number(plans.active) > 0 && Number(plans.monthly) > 0) {
    const m = Math.ceil(gap / Number(plans.monthly));
    lines.push(`${Number(plans.active).toLocaleString("en-US")} giving plan${Number(plans.active) === 1 ? "" : "s"} bring in ${usd0(plans.monthly)} a month${m <= 120 ? `; at that pace alone the goal is ${m} month${m === 1 ? "" : "s"} away` : ""}.`);
  }
  const dl = ledger.goal?.deadline ? Date.parse(ledger.goal.deadline + "T23:59:59") : NaN;
  if (Number.isFinite(dl) && dl > now) {
    const days = Math.max(1, Math.ceil((dl - now) / DAY));
    lines.push(`To get there by ${new Date(dl).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}: ${usd(goal.remaining / days)} a day for ${days} day${days === 1 ? "" : "s"}.`);
  }
  const areas = [...(ledger.areas || [])].filter((a) => a.area !== "Not given").sort((a, b) => b.received - a.received);
  if (areas.length >= 2 && areas[0].received > areas[1].received) {
    lines.push(`${areas[0].area} leads with ${usd0(areas[0].received)} received. ${areas[1].area} is ${usd0(areas[0].received - areas[1].received)} behind.`);
  }
  return { headline: ledger.goal?.headline || `Help reach “${goal.title}”`, goal, lines };
}

/** One line about what a gift does, for under the amount box. */
export function giftImpact(ledger, amount, plan) {
  const goal = nextGoal(ledger?.milestones, Number(ledger?.totals?.received) || 0);
  const total = plan ? amount * plan.payments : amount;
  if (!goal || !(total > 0)) return "";
  const pct = (total / goal.remaining) * 100;
  const share = pct >= 100 ? "enough to reach it" : pct >= 0.1 ? `${pct.toFixed(pct < 10 ? 1 : 0)}% of what's still needed` : "a real step toward it";
  return plan ? `${plan.payments} payments of ${usd(amount)} = ${usd(total)}, ${share} for “${goal.title}”.`
    : `${usd(total)} is ${share} for “${goal.title}”.`;
}
