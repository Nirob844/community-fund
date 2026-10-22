// POST /api/stripe-webhook : Stripe calls this after payments, refunds and disputes.
// The signature is verified; every write is idempotent (unique Stripe ids), so retries are safe.
// Events to enable in Stripe: checkout.session.completed, checkout.session.async_payment_succeeded,
// refund.created, refund.updated, charge.dispute.created, charge.dispute.closed,
// invoice.paid, invoice.payment_failed, customer.subscription.deleted (giving plans)
import { db, env, stripeClient, json, fail, fmtUSD, logActivity, FREQ } from "../lib/util.mjs";
import { sendEmail, receiptNumber } from "../lib/email.mjs";

const day = (unix) => new Date((unix || Date.now() / 1000) * 1000).toISOString().slice(0, 10);

async function onPaid(stripe, s, session, event) {
  const pledgeId = session.metadata?.pledge_id || null;
  const contributorId = session.metadata?.contributor_id || null;
  let label = "Anonymous neighbor", area = "", email = "", first = "neighbor";
  if (contributorId) {
    const { data: c } = await s.from("contributors").select("public_label, area, email, full_name").eq("id", contributorId).maybeSingle();
    if (c) { label = c.public_label; area = c.area; email = c.email; first = (c.full_name || "").split(" ")[0] || "neighbor"; }
  }
  // Expand to learn the charge id (needed for refunds/disputes) and the processing fee.
  let chargeId = null, bt = null;
  try {
    const full = await stripe.checkout.sessions.retrieve(session.id, { expand: ["payment_intent.latest_charge.balance_transaction"] });
    const ch = full.payment_intent?.latest_charge;
    chargeId = typeof ch === "string" ? ch : ch?.id || null;
    bt = ch && typeof ch === "object" && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  } catch (e) { console.warn("expand skipped", e?.message); }

  const amount = (session.amount_total || 0) / 100;
  const date = day(event.created);
  const ins = await s.from("receipts").upsert({
    contributor_id: contributorId, pledge_id: pledgeId, public_label: label, area, amount, received_on: date,
    method: "Online (Stripe)", reference: session.id, stripe_session_id: session.id, stripe_charge_id: chargeId, created_by: null,
  }, { onConflict: "stripe_session_id", ignoreDuplicates: true }).select("id");
  if (ins.error) throw ins.error;
  if (bt && bt.fee > 0) {
    await s.from("expenses").upsert({ spent_on: day(bt.created), amount: bt.fee / 100, payee: "Stripe", category: "Platform and bank fees",
      description: "Card processing fee", status: "paid", paid_on: day(bt.created), stripe_ref: bt.id, created_by: null }, { onConflict: "stripe_ref", ignoreDuplicates: true });
  }
  const newRow = ins.data?.[0];
  if (newRow && email) await sendEmail({ to: email, kind: "receipt", contributorId, data: { name: first, amount, date, method: "Card (Stripe)", number: receiptNumber(newRow.id) } });
}

async function receiptForCharge(s, chargeId) {
  const { data } = await s.from("receipts").select("id, contributor_id, public_label, area, amount").eq("stripe_charge_id", chargeId).maybeSingle();
  return data;
}

async function onRefund(s, refund) {
  if (refund.status === "failed" || refund.status === "canceled") {
    await s.from("refunds").delete().eq("stripe_ref", refund.id);
    return;
  }
  if (refund.status !== "succeeded") return;
  const r = await receiptForCharge(s, refund.charge);
  if (!r) { console.warn("refund for unknown charge", refund.charge); return; }
  const { error } = await s.from("refunds").upsert({
    receipt_id: r.id, contributor_id: r.contributor_id, public_label: r.public_label, area: r.area, amount: refund.amount / 100,
    kind: "refund", method: "Stripe", reason: (refund.metadata?.reason || refund.reason || "").slice(0, 160), refunded_on: day(refund.created),
    stripe_ref: refund.id, created_by: null,
  }, { onConflict: "stripe_ref", ignoreDuplicates: true });
  if (error) throw error;
}

async function disputeFee(s, dispute) {
  const fee = (dispute.balance_transactions || []).reduce((a, t) => a + (t.fee || 0), 0);
  const ref = "dfee_" + dispute.id;
  if (fee > 0) {
    await s.from("expenses").upsert({ spent_on: day(dispute.created), amount: fee / 100, payee: "Stripe", category: "Platform and bank fees",
      description: "Chargeback (dispute) fee", status: "paid", paid_on: day(dispute.created), stripe_ref: ref, created_by: null }, { onConflict: "stripe_ref" });
  } else {
    await s.from("expenses").delete().eq("stripe_ref", ref);
  }
}

async function onDispute(s, dispute, closed) {
  const r = await receiptForCharge(s, dispute.charge);
  if (!r) { console.warn("dispute for unknown charge", dispute.charge); return; }
  await disputeFee(s, dispute);
  if (!closed) {
    await s.from("receipts").update({ disputed: true }).eq("id", r.id);
    const to = process.env.TREASURER_EMAIL;
    if (to) await sendEmail({ to, kind: "alert", data: { title: "A card payment is being disputed", lines: [
      `${r.public_label} (${r.area || "no area"}) has disputed a ${fmtUSD(r.amount)} card payment. Reason given: ${dispute.reason || "not stated"}.`,
      "Respond with evidence in the Stripe dashboard before the deadline. The amount is shown as 'under dispute' in the books until it is resolved."] } });
    return;
  }
  await s.from("receipts").update({ disputed: false }).eq("id", r.id);
  if (dispute.status === "lost") {
    const { error } = await s.from("refunds").upsert({ receipt_id: r.id, contributor_id: r.contributor_id, public_label: r.public_label, area: r.area,
      amount: dispute.amount / 100, kind: "dispute_lost", method: "Stripe", reason: `Chargeback: ${dispute.reason || "not stated"}`.slice(0, 160),
      refunded_on: day(dispute.created), stripe_ref: dispute.id, created_by: null }, { onConflict: "stripe_ref", ignoreDuplicates: true });
    if (error) throw error;
  }
}

// ---------- Giving plans (Stripe subscriptions) ----------
const subIdOf = (inv) => inv.parent?.subscription_details?.subscription || (typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id) || null;
const planMetaOf = (inv) => inv.parent?.subscription_details?.metadata?.plan_id || inv.subscription_details?.metadata?.plan_id
  || inv.lines?.data?.find((l) => l.metadata?.plan_id)?.metadata?.plan_id || null;
async function planFor(s, { subscription, planId }) {
  const cols = "id, contributor_id, pledge_id, installment, frequency, payments, paid_count, status, stripe_subscription_id";
  if (subscription) { const { data } = await s.from("giving_plans").select(cols).eq("stripe_subscription_id", subscription).maybeSingle(); if (data) return data; }
  if (planId) { const { data } = await s.from("giving_plans").select(cols).eq("id", planId).maybeSingle(); return data; }
  return null;
}
async function contributorInfo(s, id) {
  const { data: c } = id ? await s.from("contributors").select("public_label, area, email, full_name").eq("id", id).maybeSingle() : { data: null };
  return { label: c?.public_label || "Anonymous neighbor", area: c?.area || "", email: c?.email || "", first: (c?.full_name || "").split(" ")[0] || "neighbor" };
}

async function onPlanCheckout(s, session) {
  const planId = session.metadata?.plan_id;
  const g = await planFor(s, { planId });
  if (!g) { console.warn("plan checkout for unknown plan", planId); return; }
  const subscription = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  // Events can arrive in any order: store the subscription first, then activate if still pending.
  await s.from("giving_plans").update({ stripe_subscription_id: subscription, stripe_customer_id: typeof session.customer === "string" ? session.customer : session.customer?.id || null }).eq("id", g.id);
  await s.from("giving_plans").update({ status: "active" }).eq("id", g.id).eq("status", "pending");
  const c = await contributorInfo(s, g.contributor_id);
  if (c.email) await sendEmail({ to: c.email, kind: "plan_started", contributorId: g.contributor_id, data: { name: c.first, installment: Number(g.installment), frequency: FREQ[g.frequency]?.word || g.frequency, payments: g.payments } });
}

async function onInvoicePaid(stripe, s, inv, event) {
  const amount = (inv.amount_paid || 0) / 100;
  if (!(amount > 0)) return;
  const g = await planFor(s, { subscription: subIdOf(inv), planId: planMetaOf(inv) });
  if (!g) { console.warn("invoice for unknown plan", inv.id); return; }
  if (!g.stripe_subscription_id && subIdOf(inv)) await s.from("giving_plans").update({ stripe_subscription_id: subIdOf(inv) }).eq("id", g.id);
  // Find the charge (for refunds/disputes) and the processing fee.
  let chargeId = typeof inv.charge === "string" ? inv.charge : inv.charge?.id || null, bt = null;
  try {
    const full = await stripe.invoices.retrieve(inv.id, { expand: ["payments.data.payment.payment_intent.latest_charge.balance_transaction"] });
    const pi = full.payments?.data?.find((p) => p.payment?.payment_intent)?.payment?.payment_intent;
    const ch = pi?.latest_charge;
    if (ch) { chargeId = typeof ch === "string" ? ch : ch.id; bt = typeof ch === "object" && typeof ch.balance_transaction === "object" ? ch.balance_transaction : null; }
  } catch (e) { console.warn("invoice expand skipped", e?.message); }
  const c = await contributorInfo(s, g.contributor_id);
  const date = day(inv.status_transitions?.paid_at || event.created);
  const ins = await s.from("receipts").upsert({
    contributor_id: g.contributor_id, pledge_id: g.pledge_id, plan_id: g.id, public_label: c.label, area: c.area, amount, received_on: date,
    method: "Online (Stripe)", reference: inv.number || inv.id, stripe_invoice_id: inv.id, stripe_charge_id: chargeId, created_by: null,
  }, { onConflict: "stripe_invoice_id", ignoreDuplicates: true }).select("id");
  if (ins.error) throw ins.error;
  if (bt && bt.fee > 0) {
    await s.from("expenses").upsert({ spent_on: day(bt.created), amount: bt.fee / 100, payee: "Stripe", category: "Platform and bank fees",
      description: "Card processing fee (giving plan)", status: "paid", paid_on: day(bt.created), stripe_ref: bt.id, created_by: null }, { onConflict: "stripe_ref", ignoreDuplicates: true });
  }
  const newRow = ins.data?.[0];
  if (!newRow) return;                                   // a retry: already recorded
  const { data: now } = await s.from("giving_plans").select("paid_count, payments, status, stripe_subscription_id").eq("id", g.id).maybeSingle();
  const n = now?.paid_count ?? g.paid_count + 1;
  if (c.email) await sendEmail({ to: c.email, kind: "receipt", contributorId: g.contributor_id, data: { name: c.first, amount, date, method: `Card (Stripe), giving plan payment ${n} of ${g.payments}`, number: receiptNumber(newRow.id) } });
  // After the last payment, end the subscription so the card is never charged again.
  if (n >= g.payments && now?.stripe_subscription_id) {
    try { await stripe.subscriptions.cancel(now.stripe_subscription_id); }
    catch (e) { if (!/No such subscription|canceled/i.test(String(e?.message))) throw e; }
  }
}

async function onInvoiceFailed(s, inv) {
  const g = await planFor(s, { subscription: subIdOf(inv), planId: planMetaOf(inv) });
  if (!g || ["completed", "cancelled"].includes(g.status)) return;
  await s.from("giving_plans").update({ status: "past_due" }).eq("id", g.id);
  await logActivity({ action: "plan.payment_failed", level: "warn", detail: { plan: g.id, attempt: inv.attempt_count || 1 } });
  const c = await contributorInfo(s, g.contributor_id);
  if (c.email && (inv.attempt_count || 1) === 1) await sendEmail({ to: c.email, kind: "plan_failed", contributorId: g.contributor_id, data: { name: c.first, installment: Number(g.installment) } });
}

async function onSubscriptionEnded(s, sub) {
  const g = await planFor(s, { subscription: sub.id, planId: sub.metadata?.plan_id });
  if (!g || ["completed", "cancelled"].includes(g.status)) return;
  const { error } = await s.rpc("cancel_plan", { pid: g.id, why: "Ended in Stripe" });
  if (error) throw error;
}

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  const stripe = stripeClient();
  const raw = await req.text();
  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET"));
  } catch {
    await logActivity({ action: "webhook.bad_signature", level: "security", req, context });
    return fail(400, "Bad signature");
  }
  const s = db(), o = event.data.object;
  try {
    switch (event.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        if (o.mode === "subscription") { if (event.type === "checkout.session.completed") await onPlanCheckout(s, o); break; }
        if (o.payment_status === "paid") await onPaid(stripe, s, o, event);
        break;
      case "invoice.paid": case "invoice.payment_succeeded": await onInvoicePaid(stripe, s, o, event); break;
      case "invoice.payment_failed": await onInvoiceFailed(s, o); break;
      case "customer.subscription.deleted": await onSubscriptionEnded(s, o); break;
      case "refund.created": case "refund.updated": case "charge.refund.updated":
        await onRefund(s, o); break;
      case "charge.dispute.created": await onDispute(s, o, false); break;
      case "charge.dispute.closed": await onDispute(s, o, true); break;
      default: break;
    }
    return json({ received: true });
  } catch (e) {
    console.error("webhook", event.type, e?.message);
    await logActivity({ action: "webhook.error", level: "error", req, context, detail: { event: event.type, id: event.id, error: String(e?.message || "").slice(0, 160) } });
    return fail(500, "Retry later");   // Stripe retries automatically
  }
};

export const config = { path: "/api/stripe-webhook" };
