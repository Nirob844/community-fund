// Sample data used only by the browser tests (never shipped to the site).
export const LEDGER = {
  generatedAt: "2026-10-16T16:00:00Z",
  org: { name: "Prospect Road Community Fund", fdacsReg: "", gofundmeUrl: "https://www.gofundme.com/", acceptOnline: false, fundStatus: "open", closedOn: null, closingNote: "" },
  milestones: [
    { amount: 10000, title: "Retain a land use attorney", desc: "The minimum needed to challenge the eligibility decision." },
    { amount: 1700000, title: "Match the land's A-1 value", desc: "Enough to make a serious offer." },
    { amount: 2000000, title: "Buy the land and open a community park", desc: "Purchase, closing and setup." },
  ],
  totals: { receivedGross: 3050, refunded: 50, received: 3000, payouts: 0, expensesPaid: 61.25, expensesUnpaid: 0, expenses: 61.25, cash: 2938.75, disputed: 0, outstandingPledges: 1150, contributors: 4, availableToReturn: 2938.75, closingPool: 2938.75 },
  areas: [
    { area: "Prospect Road", received: 2400, outstanding: 0, contributors: 1 },
    { area: "Whitfield", received: 0, outstanding: 1000, contributors: 1 },
    { area: "Magnolia Point", received: 500, outstanding: 0, contributors: 1 },
    { area: "Tuttle Avenue", received: 100, outstanding: 150, contributors: 1 },
  ],
  people: [
    { label: "Lee M.", area: "Prospect Road", pledged: 0, received: 2400, outstanding: 0, share: 0.8, refund: 2351 },
    { label: "Peter P.", area: "Magnolia Point", pledged: 500, received: 500, outstanding: 0, share: 0.1667, refund: 489.79 },
    { label: "Jo K.", area: "Tuttle Avenue", pledged: 250, received: 100, outstanding: 150, share: 0.0333, refund: 97.96 },
    { label: "Anonymous neighbor", area: "Whitfield", pledged: 1000, received: 0, outstanding: 1000, share: 0, refund: 0 },
  ],
  peopleTotal: 4,
  receipts: [
    { date: "2026-10-13", label: "Lee M.", area: "Prospect Road", method: "GoFundMe", amount: 2400, disputed: false },
    { date: "2026-10-12", label: "Jo K.", area: "Tuttle Avenue", method: "Check", amount: 150, disputed: false },
    { date: "2026-10-10", label: "Peter P.", area: "Magnolia Point", method: "Online (Stripe)", amount: 500, disputed: false },
  ],
  receiptsTotal: 3,
  refunds: [{ date: "2026-10-14", label: "Jo K.", area: "Tuttle Avenue", amount: 50, kind: "refund", reason: "Overpaid" }],
  expenses: [{ date: "2026-10-11", payee: "Florida Dept. of State", category: "Registration and filings", description: "Articles of incorporation", status: "paid", amount: 61.25 }],
  expensesTotal: 1,
  methods: [{ method: "GoFundMe", amount: 2400, n: 1 }, { method: "Online (Stripe)", amount: 500, n: 1 }, { method: "Check", amount: 150, n: 1 }],
  categories: [{ category: "Registration and filings", amount: 61.25 }],
  months: [{ month: "2026-10", n: 3, received: 3050, refunded: 50, spent: 61.25 }],
  daily: [{ date: "2026-10-10", amount: 500 }, { date: "2026-10-12", amount: 150 }, { date: "2026-10-13", amount: 2400 }, { date: "2026-10-14", amount: -50 }],
  sizes: [0, 0, 1, 0, 1, 1],
  limits: { minGift: 5, maxGift: 10000, maxPledge: 2000000, allowPlans: false, maxPlanPayments: 24, suggestedAmounts: [25, 50, 100, 250, 500, 1000] },
  goal: { promptsEnabled: true, headline: "", deadline: null },
  plans: { active: 0, monthly: 0, stillToCome: 0 },
};
export const EMPTY_LEDGER = { ...LEDGER, totals: Object.fromEntries(Object.keys(LEDGER.totals).map((k) => [k, 0])), areas: [], people: [], peopleTotal: 0, receipts: [], receiptsTotal: 0, refunds: [], expenses: [], expensesTotal: 0, methods: [], categories: [], months: [], daily: [], sizes: [0, 0, 0, 0, 0, 0] };
export const POSTS = { posts: [{ slug: "county-replies", title: "The county replied to our letter", summary: "What the Development Services Director said, and what happens next.", body: "First paragraph.\n\nSecond paragraph.", published_on: "2026-10-15" }] };

// Stand-in for the Supabase browser client: in-memory tables, role from window.__role,
// the database's row rules imitated per role. Records every write in window.__writes and
// every rpc call in window.__rpc.
export const fakeSupabaseModule = `
const role = window.__role || null;
const RANK = { developer: 0, auditor: 1, recorder: 2, treasurer: 3 };
const can = (r) => (RANK[role] ?? -1) >= RANK[r] && role !== "developer";
const db = {
  contributors: [
    { id: "C1", full_name: "Peter Powell", email: "p@example.org", address: "1 Magnolia", area: "Magnolia Point", public_label: "Peter P.", created_at: "2026-10-01" },
    { id: "C2", full_name: "Jo King", email: "jo@example.org", address: "", area: "Tuttle Avenue", public_label: "Jo K.", created_at: "2026-10-02" },
  ],
  pledges: [
    { id: "P1", contributor_id: "C1", amount: "500", pledged_on: "2026-10-09", status: "paid", source: "website", created_by: null, note: "" },
    { id: "P2", contributor_id: "C2", amount: "250", pledged_on: "2026-10-11", status: "partial", source: "staff", created_by: "u-t", note: "" },
  ],
  receipts: [
    { id: "R1", contributor_id: "C1", public_label: "Peter P.", area: "Magnolia Point", amount: "500", received_on: "2026-10-10", method: "Online (Stripe)", reference: "cs_1", deposit_ref: "", created_by: null, disputed: false, stripe_charge_id: "ch_1" },
    { id: "R2", contributor_id: "C2", public_label: "Jo K.", area: "Tuttle Avenue", amount: "100", received_on: "2026-10-12", method: "Check", reference: "#1001", deposit_ref: "DEP-0", created_by: "u-t", disputed: false },
  ],
  refunds: [],
  expenses: [{ id: "E1", spent_on: "2026-10-11", amount: "61.25", payee: "Florida Dept. of State", category: "Registration and filings", description: "", status: "unpaid", created_by: "u-t" }],
  settings: [{ id: 1, org_name: "Prospect Road Community Fund", fdacs_reg: "", gofundme_url: "", accept_online: false, fund_status: "open", closing_note: "", milestones: [{ amount: 10000, title: "Retain a land use attorney", desc: "x" }, { amount: 2000000, title: "Buy the land", desc: "Park" }],
    min_gift: 5, max_gift: 10000, max_pledge: 2000000, max_deposit: 250000, allow_plans: true, max_plan_payments: 24, suggested_amounts: [25, 50, 100, 250, 500, 1000], prompts_enabled: true, prompt_headline: "", goal_deadline: null, handover_at: null, keys_rotated_on: null }],
  giving_plans: [
    { id: "G1", contributor_id: "C2", pledge_id: "P2", installment: "50", frequency: "monthly", payments: 5, method: "manual", status: "active", start_on: "2026-10-11", paid_count: 2, paid_total: "100", created_at: "2026-10-11" },
    { id: "G2", contributor_id: "C1", pledge_id: "P1", installment: "25", frequency: "weekly", payments: 4, method: "card", status: "completed", start_on: "2026-09-01", paid_count: 4, paid_total: "100", created_at: "2026-09-01" },
  ],
  activity_log: [
    { id: 2, at: new Date(Date.now() - 3600000).toISOString(), actor: null, actor_label: "", role: "", action: "access.denied", level: "security", path: "/api/staff", detail: { reason: "not an active team member" }, ip_hash: "ab12" },
    { id: 1, at: new Date(Date.now() - 7200000).toISOString(), actor: "u-t", actor_label: "t@example.org", role: "treasurer", action: "client.sign_in", level: "info", path: "", detail: { page: "admin" }, ip_hash: "" },
  ],
  audit_log: [{ id: 1, at: "2026-10-12T12:00:00Z", actor: "u-t", table_name: "receipts", op: "INSERT", row_id: "R2", new_row: { amount: "100", public_label: "Jo K." } }],
  admins: [{ user_id: "u-t", display_name: "Tess" }],
  posts: [],
  email_log: [],
};
window.__db = db; window.__writes = []; window.__rpc = [];
const deny = { message: "new row violates row-level security policy" };
const allowed = (t, op) => {
  if (!role) return false;
  if (op === "select") return role !== "developer" || ["settings", "activity_log", "admins"].includes(t);
  if (["contributors", "pledges", "receipts", "giving_plans"].includes(t) && op === "insert") return can("recorder");
  return can("treasurer");
};
const contains = (v, q) => String(v || "").toLowerCase().includes(q.toLowerCase());
function applyOr(rows, expr, table) {
  const parts = expr.split(",").map((p) => p.split(".ilike.%")).map(([k, v]) => [k, (v || "").replace(/%$/, "")]);
  return rows.filter((r) => { const src = table ? r[table] || {} : r; return parts.some(([k, q]) => contains(src[k], q)); });
}
class Q {
  constructor(t) { this.t = t; this.op = "select"; this.filters = []; this.ors = []; this.one = null; }
  select(cols, opts) { this.cols = cols || "*"; this.count = opts && opts.count; return this; }
  order() { return this; } limit(n) { this.lim = n; return this; } range(a, b) { this.rng = [a, b]; return this; }
  eq(k, v) { this.filters.push([k, v, "eq"]); return this; } neq(k, v) { this.filters.push([k, v, "neq"]); return this; }
  in(k, vs) { this.filters.push([k, vs, "in"]); return this; } gte(k, v) { this.filters.push([k, v, "gte"]); return this; }
  ilike(k, v) { this.filters.push([k, String(v).replace(/%/g, "").toLowerCase(), "ilike"]); return this; }
  or(expr, opts) { this.ors.push([expr, opts && opts.referencedTable]); return this; }
  maybeSingle() { this.one = "maybe"; return this; } single() { this.one = "single"; return this; }
  insert(row) { this.op = "insert"; this.row = row; return this; }
  update(p) { this.op = "update"; this.row = p; return this; }
  delete() { this.op = "delete"; return this; }
  then(ok, bad) { return Promise.resolve(this.exec()).then(ok, bad); }
  exec() {
    const rows = (db[this.t] ||= []);
    let hit = rows.filter((x) => this.filters.every(([k, v, op]) => op === "neq" ? x[k] !== v : op === "in" ? v.includes(x[k]) : op === "gte" ? String(x[k]) >= String(v)
      : op === "ilike" ? String(x[k] || "").toLowerCase().includes(v) : x[k] === v));
    if (this.op === "select") {
      if (!allowed(this.t, "select")) return { data: this.one ? null : [], count: 0, error: null };
      if (["pledges", "giving_plans"].includes(this.t) && /contributors/.test(this.cols)) hit = hit.map((p) => ({ ...p, contributors: db.contributors.find((c) => c.id === p.contributor_id) || null }));
      for (const [e, tbl] of this.ors) hit = applyOr(hit, e, tbl);
      const count = hit.length;
      if (this.rng) hit = hit.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim) hit = hit.slice(0, this.lim);
      return { data: this.one ? hit[0] || null : hit, count, error: null };
    }
    if (!allowed(this.t, this.op)) return { data: null, error: deny };
    window.__writes.push({ table: this.t, op: this.op, row: this.row, filters: this.filters });
    if (this.op === "insert") { const r = { id: "N" + window.__writes.length, ...this.row }; rows.push(r); return { data: this.one ? r : [r], error: null }; }
    if (this.op === "update") { hit.forEach((r) => Object.assign(r, this.row)); return { data: hit, error: null }; }
    if (this.op === "delete") { db[this.t] = rows.filter((r) => !hit.includes(r)); return { data: hit, error: null }; }
  }
}
function totals() {
  const sum = (a, f) => a.reduce((s, x) => s + Number(f(x)), 0);
  const gross = sum(db.receipts, (r) => r.amount), back = sum(db.refunds.filter((f) => f.kind !== "closing_payout"), (f) => f.amount);
  const pay = sum(db.refunds.filter((f) => f.kind === "closing_payout"), (f) => f.amount);
  const ep = sum(db.expenses.filter((e) => e.status === "paid"), (e) => e.amount), eu = sum(db.expenses.filter((e) => e.status === "unpaid"), (e) => e.amount);
  return { receivedGross: gross, refunded: back, received: gross - back, payouts: pay, expensesPaid: ep, expensesUnpaid: eu, expenses: ep + eu, cash: gross - back - ep - pay, outstandingPledges: 150, closingPool: gross - back - ep - eu };
}
class R {
  constructor(name, args) { this.name = name; this.args = args; window.__rpc.push({ name, args }); }
  range(a, b) { this.rng = [a, b]; return this; }
  then(ok, bad) { return Promise.resolve(this.exec()).then(ok, bad); }
  exec() {
    const n = this.name;
    if (n === "staff_role") return { data: role || null, error: null };
    if (n === "ledger_totals") return { data: totals(), error: null };
    if (n === "closing_plan") return { data: [
      { contributor_id: "C1", full_name: "Peter Powell", email: "p@example.org", label: "Peter P.", area: "Magnolia Point", contributed: 500, share: 0.833333, due: 366.04, paid_out: 0, remaining: 366.04 },
      { contributor_id: "C2", full_name: "Jo King", email: "jo@example.org", label: "Jo K.", area: "Tuttle Avenue", contributed: 100, share: 0.166667, due: 73.21, paid_out: 0, remaining: 73.21 }], error: null };
    if (n === "export_journal") { const rows = [{ entry_date: "2026-10-10", entry: "Contribution", account: "Cash", debit: 500, credit: 0, memo: "Peter P.", ref: "R1" }, { entry_date: "2026-10-10", entry: "Contribution", account: "Contribution revenue", debit: 0, credit: 500, memo: "Peter P.", ref: "R1" }]; return { data: this.rng && this.rng[0] > 0 ? [] : rows, error: null }; }
    if (n === "audit_verify") return { data: { ok: true, checked: 1, erased: 0, firstBadId: null, reason: null }, error: null };
    if (n === "activity_verify") return { data: { ok: true, checked: db.activity_log.length, firstBadId: null }, error: null };
    if (n === "log_activity") { db.activity_log.unshift({ id: db.activity_log.length + 1, at: new Date().toISOString(), actor: "u-t", actor_label: "staff@example.org", role, action: this.args.act, level: this.args.act === "client.error" ? "error" : "info", path: "", detail: this.args.info || {} }); return { data: null, error: null }; }
    if (n === "area_counts") return { data: [{ area: "Magnolia Point", contributors: 1, receipts: 0 }, { area: "Tuttle Avenue", contributors: 1, receipts: 0 }], error: null };
    if (n === "rename_area") return can("treasurer") ? { data: 1, error: null } : { data: null, error: { message: "not allowed" } };
    if (["anonymize_contributor", "merge_contributors"].includes(n)) return can("treasurer") ? { data: null, error: null } : { data: null, error: { message: "not allowed" } };
    return { data: null, error: { message: "unknown rpc " + n } };
  }
}
export function createClient() {
  return {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u-t", email: "staff@example.org" }, access_token: "tok" } } }),
      onAuthStateChange() {}, signInWithOtp: async () => ({}), verifyOtp: async () => ({}), signOut: async () => ({}),
    },
    rpc: (name, args) => new R(name, args),
    from: (t) => new Q(t),
  };
}
`;
