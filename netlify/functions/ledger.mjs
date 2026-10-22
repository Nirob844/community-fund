// GET /api/ledger : public, de-identified figures. All totals are computed inside the
// database (public_ledger), so they stay exact however many rows there are.
import { db, json, fail } from "../lib/util.mjs";

export default async (req) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  try {
    const { data, error } = await db().rpc("public_ledger_v2");
    if (error) throw error;
    return json(data, 200, {
      "cache-control": "public, max-age=30",
      "netlify-cdn-cache-control": "public, s-maxage=30, stale-while-revalidate=120",
    });
  } catch (e) {
    console.error("ledger", e?.message);
    return fail(500, "The ledger is temporarily unavailable.");
  }
};

export const config = { path: "/api/ledger", rateLimit: { windowLimit: 120, windowSize: 60, aggregateBy: ["ip", "domain"] } };
