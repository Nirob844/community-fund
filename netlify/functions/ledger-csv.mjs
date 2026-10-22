// GET /api/ledger-csv : the complete public ledger as CSV (every row, paged from the
// database 1,000 at a time so nothing is cut off). Public columns only.
import { db, fail } from "../lib/util.mjs";

const q = (v) => typeof v === "number" ? String(v) : `"${String(v ?? "").replace(/"/g, '""').replace(/^[=+\-@\t\r]/, "'$&")}"`;

async function all(s, table, cols, order) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await s.from(table).select(cols).order(order, { ascending: true }).order("id", { ascending: true }).range(from, from + 999);
    if (error) throw error;
    out.push(...data);
    if (data.length < 1000) return out;
  }
}

export default async (req) => {
  if (req.method !== "GET") return fail(405, "Method not allowed");
  try {
    const s = db();
    const [rc, rf, ex] = await Promise.all([
      all(s, "receipts", "id, received_on, public_label, area, method, amount, disputed", "received_on"),
      all(s, "refunds", "id, refunded_on, public_label, area, kind, method, reason, amount", "refunded_on"),
      all(s, "expenses", "id, spent_on, payee, category, description, status, amount", "spent_on"),
    ]);
    const rows = [["type", "date", "name_or_payee", "area_or_category", "method_or_description", "status", "amount"],
      ...rc.map((x) => ["contribution", x.received_on, x.public_label, x.area, x.method, x.disputed ? "disputed" : "received", Number(x.amount)]),
      ...rf.map((x) => [x.kind === "closing_payout" ? "returned_to_contributor" : x.kind === "dispute_lost" ? "chargeback" : "refund", x.refunded_on, x.public_label, x.area, x.method + (x.reason ? " · " + x.reason : ""), "paid", -Number(x.amount)]),
      ...ex.map((x) => ["expense", x.spent_on, x.payee, x.category, x.description, x.status, -Number(x.amount)])];
    const today = new Date().toISOString().slice(0, 10);
    return new Response("﻿" + rows.map((r) => r.map(q).join(",")).join("\r\n"), { headers: {
      "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="community-fund-ledger-${today}.csv"`,
      "cache-control": "public, max-age=60", "x-content-type-options": "nosniff" } });
  } catch (e) {
    console.error("ledger-csv", e?.message);
    return fail(500, "The ledger download is temporarily unavailable.");
  }
};

export const config = { path: "/api/ledger-csv", rateLimit: { windowLimit: 20, windowSize: 60, aggregateBy: ["ip", "domain"] } };
