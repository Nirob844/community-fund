// POST /api/give : a contributor gives again from their private link, without retyping their details.
// Body: {t: private token, amount, plan?: {frequency, payments}}  -> a new pledge (or plan) and its payment page
//    or {t, payOwed: true}                                       -> pay what is still owed on their oldest open pledge
import { db, json, fail, sameOrigin, readJson, getSettings, onlineOpen, logActivity } from "../lib/util.mjs";
import { validateGift, createPledge, checkoutPledge, checkoutPlan } from "../lib/giving.mjs";

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  let b;
  try { b = await readJson(req, 1024); } catch (e) { return fail(e.status || 400, e.message); }
  const t = String(b.t || "");
  if (!/^[0-9a-f]{36}$/.test(t)) return fail(404, "Link not recognized.");
  const s = db();
  const { data: c } = await s.from("contributors").select("id").eq("share_token", t).maybeSingle();
  if (!c) {
    await logActivity({ action: "donor.bad_link", level: "warn", req, context, detail: { endpoint: "give" } });
    return fail(404, "Link not recognized.");
  }
  const st = await getSettings(s);
  if (st.fund_status !== "open") return fail(409, "The fund has closed and is no longer taking payments. Thank you.");
  if (!onlineOpen(st)) return fail(409, "Online payments are not open yet. The treasurer can tell you other ways to give.");
  try {
    if (b.payOwed) {
      const { data: ps } = await s.from("pledges").select("id, status, pledged_on, created_at").eq("contributor_id", c.id);
      const { data: plans } = await s.from("giving_plans").select("pledge_id").eq("contributor_id", c.id);
      const planPledges = new Set((plans || []).map((x) => x.pledge_id));
      const open = (ps || []).filter((p) => ["open", "partial"].includes(p.status) && !planPledges.has(p.id))
        .sort((a, b) => String(a.pledged_on).localeCompare(String(b.pledged_on)) || String(a.created_at).localeCompare(String(b.created_at)));
      if (!open.length) return fail(409, "Nothing is owed on your pledges. Thank you!");
      return json(await checkoutPledge(s, open[0].id, st, { cancelPath: "/share/" }));
    }
    const gift = validateGift(b, st);
    const { pledgeId, planId } = await createPledge(s, c.id, gift);
    await logActivity({ action: planId ? "donor.plan_start" : "donor.give_again", req, context, detail: { amount: gift.amount, plan: !!planId } });
    return json(planId ? await checkoutPlan(s, planId, st, { cancelPath: "/share/" }) : await checkoutPledge(s, pledgeId, st, { cancelPath: "/share/" }), 201);
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error("give", e?.message);
    return fail(500, "We could not start your gift. Please try again.");
  }
};

export const config = { path: "/api/give", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
