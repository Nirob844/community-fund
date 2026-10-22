// POST /api/notify : staff ask the server to email a contributor about something they recorded.
// Body: {kind: "receipt" | "refund" | "payout", id}. The server looks everything up itself,
// so the browser can't change what is sent or to whom.
import { db, json, fail, sameOrigin, readJson, requireStaff } from "../lib/util.mjs";
import { sendEmail, receiptNumber } from "../lib/email.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  let b;
  try { b = await readJson(req, 512); } catch (e) { return fail(e.status || 400, e.message); }
  const kind = String(b.kind || "");
  if (!["receipt", "refund", "payout"].includes(kind) || !UUID.test(String(b.id || ""))) return fail(400, "Unknown request.");
  const me = await requireStaff(req, kind === "receipt" ? "recorder" : "treasurer", context);
  if (!me) return fail(403, "Your role can't send this email.");
  const s = db();
  const table = kind === "receipt" ? "receipts" : "refunds";
  const { data: row } = await s.from(table).select("*").eq("id", b.id).maybeSingle();
  if (!row) return fail(404, "Not found.");
  if (kind === "payout" && row.kind !== "closing_payout") return fail(400, "Not a closing payout.");
  if (!row.contributor_id) return fail(400, "No contributor is linked to this entry.");
  const { data: c } = await s.from("contributors").select("email, full_name").eq("id", row.contributor_id).maybeSingle();
  if (!c?.email) return json({ status: "no-address" });
  const first = (c.full_name || "").split(" ")[0] || "neighbor";
  const data = kind === "receipt"
    ? { name: first, amount: Number(row.amount), date: row.received_on, method: row.method, number: receiptNumber(row.id) }
    : { name: first, amount: Number(row.amount), date: row.refunded_on, method: row.method, reason: row.reason };
  const r = await sendEmail({ to: c.email, kind, contributorId: row.contributor_id, data });
  return json(r);
};

export const config = { path: "/api/notify", rateLimit: { windowLimit: 60, windowSize: 60, aggregateBy: ["ip", "domain"] } };
