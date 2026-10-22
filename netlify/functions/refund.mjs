// POST /api/refund : treasurer refunds an online (Stripe) payment back to the card.
// Body: {receiptId, amount, reason}. Manual refunds (check, Zelle, cash) are recorded
// directly in the staff console; this endpoint exists because only the server holds the Stripe key.
import { db, json, fail, sameOrigin, readJson, requireStaff, stripeClient, clean, logActivity } from "../lib/util.mjs";
import { sendEmail } from "../lib/email.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  const me = await requireStaff(req, "treasurer", context);
  if (!me) return fail(403, "Only the treasurer can issue refunds.");
  let b;
  try { b = await readJson(req, 1024); } catch (e) { return fail(e.status || 400, e.message); }
  if (!UUID.test(String(b.receiptId || ""))) return fail(400, "Unknown receipt.");
  const amount = Math.round(Number(b.amount) * 100) / 100, reason = clean(b.reason, 160);
  const s = db();
  const { data: r } = await s.from("receipts").select("id, contributor_id, public_label, area, amount, method, stripe_charge_id, stripe_session_id").eq("id", b.receiptId).maybeSingle();
  if (!r) return fail(404, "Unknown receipt.");
  if (r.method !== "Online (Stripe)" || !(r.stripe_charge_id || r.stripe_session_id)) return fail(400, "This payment wasn't made by card. Record a manual refund instead.");
  const { data: prior } = await s.from("refunds").select("amount").eq("receipt_id", r.id).neq("kind", "closing_payout");
  const left = Number(r.amount) - (prior || []).reduce((a, x) => a + Number(x.amount), 0);
  if (!(amount > 0) || amount > left + 1e-9) return fail(400, `Enter an amount up to ${left.toFixed(2)}.`);

  const stripe = stripeClient();
  try {
    let charge = r.stripe_charge_id;
    if (!charge) {
      const sess = await stripe.checkout.sessions.retrieve(r.stripe_session_id, { expand: ["payment_intent"] });
      charge = typeof sess.payment_intent?.latest_charge === "string" ? sess.payment_intent.latest_charge : sess.payment_intent?.latest_charge?.id;
      if (charge) await s.from("receipts").update({ stripe_charge_id: charge }).eq("id", r.id);
    }
    const refund = await stripe.refunds.create({ charge, amount: Math.round(amount * 100), metadata: { receipt_id: r.id, reason, by: me.user.id } },
      { idempotencyKey: `refund-${r.id}-${Math.round(amount * 100)}-${Math.round(left * 100)}` });
    const row = { receipt_id: r.id, contributor_id: r.contributor_id, public_label: r.public_label, area: r.area, amount, kind: "refund",
      method: "Stripe", reason, refunded_on: new Date().toISOString().slice(0, 10), stripe_ref: refund.id, created_by: me.user.id };
    const { error } = await s.from("refunds").upsert(row, { onConflict: "stripe_ref", ignoreDuplicates: true });
    if (error) throw error;
    if (r.contributor_id) {
      const { data: c } = await s.from("contributors").select("email, full_name").eq("id", r.contributor_id).maybeSingle();
      if (c?.email) await sendEmail({ to: c.email, kind: "refund", contributorId: r.contributor_id, data: { name: c.full_name.split(" ")[0], amount, date: row.refunded_on, method: "Stripe", reason } });
    }
    await logActivity({ action: "refund.issue", req, context, actor: me.user.id, actorLabel: me.user.email, role: me.role, detail: { receipt: r.id, amount, stripe: refund.id } });
    return json({ ok: true, refundId: refund.id, status: refund.status });
  } catch (e) {
    console.error("refund", e?.message);
    await logActivity({ action: "refund.failed", level: "error", req, context, actor: me.user.id, actorLabel: me.user.email, role: me.role, detail: { receipt: r.id, error: String(e?.message || "").slice(0, 160) } });
    return fail(502, "Stripe could not process the refund: " + String(e?.message || "unknown error").slice(0, 120));
  }
};

export const config = { path: "/api/refund", rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
