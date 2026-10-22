// Shared giving logic: validating a gift against the treasurer's limits, recording a pledge
// (one-time or a giving plan of several smaller payments) and opening Stripe Checkout.
// Amounts always come from the database, never from the browser.
import { env, stripeClient, onlineOpen, FREQ, fmtUSD } from "./util.mjs";

export class GiftError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Check a gift request ({amount, plan: {frequency, payments}}) against the limits. */
export function validateGift(b, st) {
  const amount = Math.round(Number(b.amount) * 100) / 100;
  const min = st.min_gift, max = st.max_gift, maxPledge = st.max_pledge;
  if (b.plan && typeof b.plan === "object") {
    const frequency = String(b.plan.frequency || ""), payments = Number(b.plan.payments);
    if (!onlineOpen(st) || !st.allow_plans) throw new GiftError(409, "Giving plans open once online card payments are available. You can pledge the total now instead.");
    if (!FREQ[frequency]) throw new GiftError(400, "Choose how often to give: weekly, monthly or every 3 months.");
    if (!Number.isInteger(payments) || payments < 2 || payments > st.max_plan_payments) throw new GiftError(400, `Choose between 2 and ${st.max_plan_payments} payments.`);
    if (!(amount >= min && amount <= max)) throw new GiftError(400, `Each payment must be between ${fmtUSD(min)} and ${fmtUSD(max)}.`);
    const total = Math.round(amount * payments * 100) / 100;
    if (total > maxPledge) throw new GiftError(400, `The plan totals ${fmtUSD(total)}, above the ${fmtUSD(maxPledge)} limit. Choose fewer payments.`);
    return { amount: total, plan: { installment: amount, frequency, payments } };
  }
  if (!(amount >= min && amount <= maxPledge)) throw new GiftError(400, `Please enter a pledge between ${fmtUSD(min)} and ${fmtUSD(maxPledge)}.`);
  return { amount, plan: null };
}

/** Record the pledge (and the plan, if any) for a contributor. */
export async function createPledge(s, contributorId, gift) {
  const note = gift.plan ? `Giving plan: ${fmtUSD(gift.plan.installment)} ${FREQ[gift.plan.frequency].word} x ${gift.plan.payments}` : "";
  const p = await s.from("pledges").insert({ contributor_id: contributorId, amount: gift.amount, note }).select("id").single();
  if (p.error) {
    if (/no longer accepting/.test(p.error.message)) throw new GiftError(409, "The fund has closed and is no longer accepting pledges. Thank you.");
    if (/between/.test(p.error.message)) throw new GiftError(400, "That amount is outside the fund's current limits.");
    throw p.error;
  }
  let planId = null;
  if (gift.plan) {
    const g = await s.from("giving_plans").insert({ contributor_id: contributorId, pledge_id: p.data.id, installment: gift.plan.installment,
      frequency: gift.plan.frequency, payments: gift.plan.payments, method: "card", created_by: null }).select("id").single();
    if (g.error) {
      await s.from("pledges").update({ status: "withdrawn", note: "Giving plan could not be created" }).eq("id", p.data.id);
      if (/switched off|at most|between/.test(g.error.message)) throw new GiftError(400, g.error.message);
      throw g.error;
    }
    planId = g.data.id;
  }
  return { pledgeId: p.data.id, planId };
}

/** What is still owed on one pledge (earlier pledges are filled first), in cents. */
export async function owedOnPledge(s, p) {
  const [{ data: all }, { data: rc }, { data: rf }] = await Promise.all([
    s.from("pledges").select("id, amount, pledged_on, created_at, status").eq("contributor_id", p.contributor_id),
    s.from("receipts").select("amount").eq("contributor_id", p.contributor_id),
    s.from("refunds").select("amount, kind").eq("contributor_id", p.contributor_id),
  ]);
  const paid = (rc || []).reduce((a, r) => a + Number(r.amount), 0)
    - (rf || []).filter((x) => x.kind !== "closing_payout").reduce((a, x) => a + Number(x.amount), 0);
  let before = 0;
  for (const x of (all || []).filter((x) => !["cancelled", "withdrawn"].includes(x.status)).sort((a, b) => String(a.pledged_on).localeCompare(String(b.pledged_on)) || String(a.created_at).localeCompare(String(b.created_at)))) {
    if (x.id === p.id) break;
    before += Number(x.amount);
  }
  return { cents: Math.round(Math.min(Number(p.amount), Math.max(0, before + Number(p.amount) - paid)) * 100), paid };
}

/** Open a one-time Stripe Checkout for a pledge. Charges what is owed, up to the per-payment limit. */
export async function checkoutPledge(s, pledgeId, st, { cancelPath = "/#pledge" } = {}) {
  const { data: p, error } = await s.from("pledges").select("id, amount, status, contributor_id, contributors(email)").eq("id", pledgeId).maybeSingle();
  if (error || !p) throw new GiftError(404, "Unknown pledge.");
  if (!["open", "partial"].includes(p.status)) throw new GiftError(409, "This pledge is already paid.");
  const { data: plan } = await s.from("giving_plans").select("id").eq("pledge_id", p.id).maybeSingle();
  if (plan) throw new GiftError(409, "This pledge is paid through its giving plan.");
  const { cents: owed, paid } = await owedOnPledge(s, p);
  if (owed < 100) throw new GiftError(409, "This pledge is already paid.");
  const due = Math.min(owed, Math.round(st.max_gift * 100));
  const site = env("URL");
  try {
    const session = await stripeClient().checkout.sessions.create({
      mode: "payment", submit_type: "donate",
      customer_email: p.contributors?.email || undefined,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: due, product_data: { name: `${st.org_name} contribution` } } }],
      metadata: { pledge_id: p.id, contributor_id: p.contributor_id },
      payment_intent_data: { metadata: { pledge_id: p.id } },
      success_url: `${site}/thanks/?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${site}${cancelPath}`,
    }, { idempotencyKey: `pledge-${p.id}-${due}-${Math.round(paid * 100)}` });
    return { url: session.url, amount: due / 100, partOfPledge: due < owed };
  } catch (e) {
    console.error("checkout", e?.message);
    throw new GiftError(502, "The payment page could not be opened. Please try again.");
  }
}

/** Open a Stripe Checkout that sets up the recurring payments of a giving plan. */
export async function checkoutPlan(s, planId, st, { cancelPath = "/#pledge" } = {}) {
  const { data: g } = await s.from("giving_plans").select("id, contributor_id, pledge_id, installment, frequency, payments, status, method, contributors(email)").eq("id", planId).maybeSingle();
  if (!g || g.method !== "card") throw new GiftError(404, "Unknown giving plan.");
  if (g.status !== "pending") throw new GiftError(409, "This giving plan is already set up.");
  if (!st.allow_plans) throw new GiftError(409, "Giving plans are not available right now.");
  if (Number(g.installment) > st.max_gift || Number(g.installment) < st.min_gift) throw new GiftError(409, "This plan is outside the fund's current limits. Please start a new one.");
  const f = FREQ[g.frequency];
  const site = env("URL");
  const meta = { plan_id: g.id, contributor_id: g.contributor_id, pledge_id: g.pledge_id || "" };
  try {
    const session = await stripeClient().checkout.sessions.create({
      mode: "subscription",
      customer_email: g.contributors?.email || undefined,
      line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: Math.round(Number(g.installment) * 100),
        recurring: { interval: f.interval, interval_count: f.interval_count },
        product_data: { name: `${st.org_name} giving plan (${g.payments} payments)` } } }],
      metadata: meta,
      subscription_data: { metadata: meta, description: `${fmtUSD(g.installment)} ${f.word}, ${g.payments} payments. Stop any time from your private link.` },
      success_url: `${site}/thanks/?session_id={CHECKOUT_SESSION_ID}&plan=1`,
      cancel_url: `${site}${cancelPath}`,
    }, { idempotencyKey: `plan-${g.id}` });
    return { url: session.url, amount: Number(g.installment), plan: true };
  } catch (e) {
    console.error("checkout plan", e?.message);
    throw new GiftError(502, "The payment page could not be opened. Please try again.");
  }
}
