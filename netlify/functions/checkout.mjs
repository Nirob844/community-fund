// POST /api/checkout : open Stripe Checkout for an existing pledge ({pledgeId}) or giving plan ({planId}).
// The amount is read from the database, never trusted from the browser. A single payment never
// exceeds the treasurer's per-payment limit; anything left stays on the pledge to pay later.
import { db, json, fail, sameOrigin, readJson, getSettings, onlineOpen, UUID } from "../lib/util.mjs";
import { checkoutPledge, checkoutPlan } from "../lib/giving.mjs";

export default async (req) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  let b;
  try { b = await readJson(req, 512); } catch (e) { return fail(e.status || 400, e.message); }
  const isPlan = b.planId !== undefined;
  const id = String((isPlan ? b.planId : b.pledgeId) || "");
  if (!UUID.test(id)) return fail(400, isPlan ? "Unknown giving plan." : "Unknown pledge.");

  const s = db();
  const st = await getSettings(s);
  if (st.fund_status !== "open") return fail(409, "The fund has closed and is no longer taking payments. Thank you.");
  // Florida requires charitable registration before soliciting: never take card payments without it.
  if (!onlineOpen(st)) return fail(409, "Online payments are not open yet. Your pledge is saved.");
  try {
    return json(isPlan ? await checkoutPlan(s, id, st) : await checkoutPledge(s, id, st));
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error("checkout", e?.message);
    return fail(500, "The payment page could not be opened. Please try again.");
  }
};

export const config = { path: "/api/checkout", rateLimit: { windowLimit: 10, windowSize: 60, aggregateBy: ["ip", "domain"] } };
