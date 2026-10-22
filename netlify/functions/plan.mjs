// POST /api/plan : stop a giving plan. Either the donor ({t: private token, planId}) or the
// treasurer (Authorization header, {planId, reason}). Future card payments stop in Stripe at once;
// money already given stays with the fund and the pledge shrinks to what was given.
import { db, json, fail, sameOrigin, readJson, requireStaff, stripeClient, clean, logActivity, UUID } from "../lib/util.mjs";
import { sendEmail } from "../lib/email.mjs";

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  let b;
  try { b = await readJson(req, 1024); } catch (e) { return fail(e.status || 400, e.message); }
  if (!UUID.test(String(b.planId || ""))) return fail(400, "Unknown giving plan.");
  const s = db();
  let actor = null, by = "donor", contributorId = null;
  if (req.headers.get("authorization")) {
    const me = await requireStaff(req, "treasurer", context);
    if (!me) return fail(403, "Only the treasurer can stop a giving plan for someone.");
    actor = me; by = "treasurer";
  } else {
    const t = String(b.t || "");
    const { data: c } = /^[0-9a-f]{36}$/.test(t) ? await s.from("contributors").select("id").eq("share_token", t).maybeSingle() : { data: null };
    if (!c) { await logActivity({ action: "donor.bad_link", level: "warn", req, context, detail: { endpoint: "plan" } }); return fail(404, "Link not recognized."); }
    contributorId = c.id;
  }
  const { data: g } = await s.from("giving_plans").select("id, contributor_id, status, stripe_subscription_id, installment, paid_count, payments").eq("id", b.planId).maybeSingle();
  if (!g || (contributorId && g.contributor_id !== contributorId)) return fail(404, "Unknown giving plan.");
  if (["completed", "cancelled"].includes(g.status)) return json({ ok: true, status: g.status });
  const reason = clean(b.reason, 160) || (by === "donor" ? "Stopped by the donor" : "Stopped by the treasurer");
  try {
    if (g.stripe_subscription_id) {
      try { await stripeClient().subscriptions.cancel(g.stripe_subscription_id); }
      catch (e) { if (!/No such subscription|canceled/i.test(String(e?.message))) throw e; }
    }
    const { error } = await s.rpc("cancel_plan", { pid: g.id, why: reason });
    if (error) throw error;
    await logActivity({ action: "plan.cancel", level: "info", req, context, actor: actor?.user.id || null, actorLabel: actor?.user.email || "donor", role: actor?.role || "", detail: { plan: g.id, by, paid: g.paid_count, of: g.payments } });
    const { data: c } = await s.from("contributors").select("email, full_name").eq("id", g.contributor_id).maybeSingle();
    if (c?.email) await sendEmail({ to: c.email, kind: "plan_stopped", contributorId: g.contributor_id, data: { name: (c.full_name || "").split(" ")[0] || "neighbor", installment: Number(g.installment), paidCount: g.paid_count, payments: g.payments } });
    return json({ ok: true, status: "cancelled" });
  } catch (e) {
    console.error("plan", e?.message);
    await logActivity({ action: "plan.cancel_failed", level: "error", req, context, detail: { plan: g.id, error: String(e?.message || "").slice(0, 160) } });
    return fail(502, "The plan could not be stopped right now. Please try again or contact the treasurer.");
  }
};

export const config = { path: "/api/plan", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
