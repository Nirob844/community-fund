// Audit & Exports domain module
import { $, fill, h, emptyRow } from "../common.js";
import { state, note, pager, friendly, who, today, logAct, csvDownload, fetchAll, KIND, PAGE } from "./context.js";

let auPage = 0;
const LABEL = {
  receipts: "Deposits",
  pledges: "Pledges",
  refunds: "Refunds and payouts",
  expenses: "Expenses",
  contributors: "Contributors",
  settings: "Settings",
  admins: "Team",
  posts: "Updates"
};

function summary(x) {
  if (x.op === "ERASE") return "Personal details erased on request";
  const o = x.old_row || {}, n = x.new_row || {};
  if (x.op === "INSERT") return ["amount", "public_label", "full_name", "title", "payee", "status", "role"].filter((k) => n[k] != null).map((k) => `${k.replace("_", " ")}: ${n[k]}`).join(" · ");
  if (x.op === "DELETE") return ["amount", "public_label", "full_name", "title", "payee"].filter((k) => o[k] != null).map((k) => `${k.replace("_", " ")}: ${o[k]}`).join(" · ");
  return Object.keys(n).filter((k) => !["updated_at", "created_at"].includes(k) && JSON.stringify(o[k]) !== JSON.stringify(n[k])).map((k) => `${k.replace("_", " ")}: ${o[k] ?? "—"} → ${n[k] ?? "—"}`).join(" · ").slice(0, 300);
}

async function checkIntegrity() {
  const el = $("auIntegrity");
  const { data: v, error } = await state.sb.rpc("audit_verify");
  if (error || !v) return note(el, "The integrity check could not run.", "warn");
  note(el, v.ok ? `Integrity verified: all ${Number(v.checked).toLocaleString()} entries are intact${v.erased ? ` (${v.erased} with personal details erased on request)` : ""}.`
    : `Warning: the audit log has been tampered with at entry ${v.firstBadId}. ${v.reason}. Tell the board and keep a copy of the latest export.`, v.ok ? "" : "err");
}

const EXPORTS = {
  journal: async () => [["date", "entry", "account", "debit", "credit", "memo", "ref"], ...(await fetchAll(() => state.sb.rpc("export_journal"))).map((r) => [r.entry_date, r.entry, r.account, Number(r.debit), Number(r.credit), r.memo, r.ref])],
  receipts: async () => [["date", "public_label", "area", "method", "amount", "reference", "deposit_slip", "disputed", "contributor_id", "entered_by", "id"],
    ...(await fetchAll(() => state.sb.from("receipts").select("*").order("received_on").order("id"))).map((r) => [r.received_on, r.public_label, r.area, r.method, Number(r.amount), r.reference, r.deposit_ref, r.disputed ? "yes" : "no", r.contributor_id || "", who(r.created_by), r.id])],
  refunds: async () => [["date", "type", "public_label", "area", "method", "reason", "amount", "receipt_id", "contributor_id", "entered_by", "id"],
    ...(await fetchAll(() => state.sb.from("refunds").select("*").order("refunded_on").order("id"))).map((r) => [r.refunded_on, KIND[r.kind], r.public_label, r.area, r.method, r.reason, Number(r.amount), r.receipt_id || "", r.contributor_id || "", who(r.created_by), r.id])],
  expenses: async () => [["date", "payee", "category", "description", "status", "paid_on", "amount", "entered_by", "id"],
    ...(await fetchAll(() => state.sb.from("expenses").select("*").order("spent_on").order("id"))).map((e) => [e.spent_on, e.payee, e.category, e.description, e.status, e.paid_on || "", Number(e.amount), who(e.created_by), e.id])],
  pledges: async () => [["date", "contributor", "email", "area", "amount", "status", "source", "note", "entered_by", "id"],
    ...(await fetchAll(() => state.sb.from("pledges").select("*, contributors(full_name, email, area)").order("pledged_on").order("id"))).map((p) => [p.pledged_on, p.contributors?.full_name, p.contributors?.email, p.contributors?.area, Number(p.amount), p.status, p.source, p.note, p.source === "website" ? "Website" : who(p.created_by), p.id])],
  contributors: async () => [["name", "email", "address", "area", "public_label", "created", "id"],
    ...(await fetchAll(() => state.sb.from("contributors").select("*").order("full_name").order("id"))).map((c) => [c.full_name, c.email, c.address, c.area, c.public_label, String(c.created_at).slice(0, 10), c.id])],
  audit: async () => [["when", "who", "area", "change", "details", "row_id"],
    ...(await fetchAll(() => state.sb.from("audit_log").select("*").order("at").order("id"))).map((x) => [x.at, who(x.actor), LABEL[x.table_name] || x.table_name, x.op, summary(x), x.row_id])],
  emails: async () => [["when", "kind", "to", "status", "error"],
    ...(await fetchAll(() => state.sb.from("email_log").select("*").order("at").order("id"))).map((x) => [x.at, x.kind, x.to_email, x.status, x.error || ""])],
  activity: async () => [["when", "who", "role", "action", "level", "path", "details", "ip_fingerprint", "id"],
    ...(await fetchAll(() => state.sb.from("activity_log").select("*").order("id"))).map((x) => [x.at, x.actor_label || (x.actor ? "staff" : "website / server"), x.role, x.action, x.level, x.path, JSON.stringify(x.detail || {}), x.ip_hash, x.id])],
};

export function initRecords() {
  state.loaders.records = async (page = 0) => {
    if (page === 0) checkIntegrity();
    auPage = Math.max(0, page);
    let q = state.sb.from("audit_log").select("*", { count: "exact" });
    if ($("auTable")?.value) q = q.eq("table_name", $("auTable").value);
    if ($("auOp")?.value) q = q.eq("op", $("auOp").value);
    const { data, count, error } = await q.order("at", { ascending: false }).range(auPage * PAGE, auPage * PAGE + PAGE - 1);
    if (error) return note($("status"), friendly(error), "err");
    fill($("auditRows"), data.length ? data.map((x) => h("tr", {},
      h("td", { class: "num" }, new Date(x.at).toLocaleString()),
      h("td", {}, who(x.actor)),
      h("td", {}, LABEL[x.table_name] || x.table_name),
      h("td", {}, { INSERT: "Added", UPDATE: "Changed", DELETE: "Deleted", ERASE: "Erased" }[x.op] || x.op),
      h("td", { class: "hint" }, summary(x))
    )) : emptyRow(5, "No changes match."));
    pager($("auditPager"), auPage, count || 0, (p) => state.loaders.records(p));
  };

  $("auTable")?.addEventListener("change", () => state.loaders.records(0));
  $("auOp")?.addEventListener("change", () => state.loaders.records(0));

  document.querySelectorAll("[data-export]").forEach((b) => b.addEventListener("click", async () => {
    const k = b.dataset.export, m = $(b.dataset.msg || "xMsg");
    b.disabled = true;
    note(m, "Preparing the file…");
    try {
      const rows = await EXPORTS[k]();
      csvDownload(`${k}${k === "contributors" ? "-PRIVATE" : ""}-${today()}.csv`, rows);
      note(m, `Downloaded ${(rows.length - 1).toLocaleString()} rows.`);
      logAct("client.export", { file: k, rows: String(rows.length - 1) });
    } catch (e) {
      note(m, friendly(e), "err");
    }
    b.disabled = false;
  }));
}
