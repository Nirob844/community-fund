// A tiny stand-in for Supabase's REST API and Stripe's API, so server functions can be
// tested without network access. Tables live in memory; every request is recorded.
export const ORIGIN = "https://fund.example.org";
Object.assign(process.env, {
  SUPABASE_URL: "https://mock.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", URL: ORIGIN,
  STRIPE_SECRET_KEY: "sk_test_mock", STRIPE_WEBHOOK_SECRET: "whsec_test_secret", TURNSTILE_SECRET_KEY: "ts-secret",
});

export const state = { tables: {}, calls: [], users: [], authUser: null, turnstileOk: true, stripeSessions: [], stripeRefunds: [], stripeCancels: [], userUpdates: [], emails: [], rpc: {}, invoice: null };
export function reset(tables = {}) {
  state.tables = structuredClone(tables); state.calls = []; state.stripeSessions = []; state.stripeRefunds = []; state.emails = [];
  state.authUser = null; state.turnstileOk = true; state.rpc = {}; state.stripeCancels = []; state.userUpdates = []; state.invoice = null;
}
process.env.RESEND_API_KEY = "re_test";

const respond = (body, status = 200) => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function filterRows(rows, params) {
  let out = rows;
  for (const [k, v] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    out = out.filter((r) => {
      const cell = r[k] == null ? "null" : String(r[k]);
      if (op === "eq") return cell === val;
      if (op === "neq") return cell !== val;
      if (op === "in") return val.replace(/[()"]/g, "").split(",").includes(cell);
      return true;
    });
  }
  return out;
}
function embed(table, rows) {
  // contributors(...) embeds for pledges
  if (table !== "pledges") return rows;
  return rows.map((p) => ({ ...p, contributors: (state.tables.contributors || []).find((c) => c.id === p.contributor_id) || null }));
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || (input.method ?? "GET")).toUpperCase();
  const headers = new Headers(init.headers || input.headers);
  const body = init.body ? (typeof init.body === "string" ? init.body : init.body.toString()) : null;
  state.calls.push({ host: url.host, path: url.pathname, method, search: url.search, body });

  if (url.host === "challenges.cloudflare.com") return respond({ success: state.turnstileOk });
  if (url.host === "api.resend.com") { const b = JSON.parse(body); state.emails.push(b); return respond({ id: "em_" + state.emails.length }); }

  if (url.host === "api.stripe.com") {
    if (url.pathname === "/v1/checkout/sessions" && method === "POST") {
      const p = new URLSearchParams(body); const sess = { id: "cs_test_" + state.stripeSessions.length, url: "https://checkout.stripe.com/c/pay/x", params: Object.fromEntries(p) };
      state.stripeSessions.push(sess); return respond(sess);
    }
    if (url.pathname.startsWith("/v1/subscriptions/") && method === "DELETE") { const id = url.pathname.split("/").pop(); state.stripeCancels.push(id); return respond({ id, status: "canceled" }); }
    if (url.pathname.startsWith("/v1/invoices/")) return respond(state.invoice || { id: url.pathname.split("/").pop(), payments: { data: [{ payment: { payment_intent: { id: "pi_9", latest_charge: { id: "ch_inv", balance_transaction: { id: "txn_inv", fee: 105, created: 1792000000 } } } } }] } });
    if (url.pathname.startsWith("/v1/checkout/sessions/")) return respond({ id: "cs", payment_intent: { id: "pi_1", latest_charge: { id: "ch_1", balance_transaction: { id: "txn_1", fee: 320, created: 1792000000 } } } });
    if (url.pathname === "/v1/refunds" && method === "POST") {
      const p = Object.fromEntries(new URLSearchParams(body)); const re = { id: "re_" + state.stripeRefunds.length, status: "succeeded", amount: Number(p.amount), charge: p.charge, params: p };
      state.stripeRefunds.push(re); return respond(re);
    }
    return respond({ error: { message: "not mocked" } }, 404);
  }

  if (url.host === "mock.supabase.co") {
    if (url.pathname === "/auth/v1/user") return state.authUser ? respond(state.authUser) : respond({ msg: "bad jwt" }, 401);
    if (url.pathname.startsWith("/auth/v1/admin/users")) {
      if (method === "GET" && url.pathname === "/auth/v1/admin/users") return respond({ users: state.users, aud: "authenticated" });
      if (method === "PUT") { const id = url.pathname.split("/").pop(); state.userUpdates.push({ id, ...JSON.parse(body || "{}") }); return respond(state.users.find((x) => x.id === id) || { id }); }
      if (method === "POST") { const b = JSON.parse(body); const u = { id: "99999999-9999-4999-8999-99999999999" + state.users.length, email: b.email }; state.users.push(u); return respond(u); }
      const id = url.pathname.split("/").pop(); const u = state.users.find((x) => x.id === id); return u ? respond(u) : respond({ msg: "not found" }, 404);
    }
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const fn = url.pathname.split("/").pop(); const handler = state.rpc[fn];
      return handler ? respond(handler(JSON.parse(body || "{}"))) : respond({ message: "no rpc " + fn }, 404);
    }
    const table = url.pathname.replace("/rest/v1/", "");
    const rows = (state.tables[table] ||= []);
    const params = [...url.searchParams];
    const wantsObject = (headers.get("accept") || "").includes("vnd.pgrst.object");
    if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": `*/${filterRows(rows, params).length}` } });
    if (method === "GET") {
      let out = embed(table, filterRows(rows, params));
      if (wantsObject) return out.length === 1 ? respond(out[0]) : respond({ code: "PGRST116", message: "0 rows" }, 406);
      return respond(out);
    }
    if (method === "POST") {
      const items = [].concat(JSON.parse(body));
      const conflict = url.searchParams.get("on_conflict");
      const ignore = (headers.get("prefer") || "").includes("ignore-duplicates");
      const added = [];
      for (const it of items) {
        if (conflict && rows.some((r) => r[conflict] === it[conflict])) {
          if (ignore) continue;
          Object.assign(rows.find((r) => r[conflict] === it[conflict]), it); continue;
        }
        if (table === "contributors" && it.email && rows.some((r) => r.email === it.email)) return respond({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
        const row = { id: crypto.randomUUID(), ...(table === "contributors" ? { share_token: "b".repeat(36) } : {}), ...(table === "pledges" ? { status: "open" } : {}),
          ...(table === "giving_plans" ? { status: "pending", paid_count: 0 } : {}), ...(table === "activity_log" ? { at: new Date().toISOString() } : {}), ...it };
        rows.push(row); added.push(row);
      }
      if (wantsObject) return respond(added[0]);
      return respond(added, 201);
    }
    if (method === "DELETE") {
      const hit = filterRows(rows, params); state.tables[table] = rows.filter((r) => !hit.includes(r)); return respond(hit);
    }
    if (method === "PATCH") {
      const hit = filterRows(rows, params); const patch = JSON.parse(body); hit.forEach((r) => Object.assign(r, patch)); return respond(hit);
    }
  }
  return respond({ error: "unmocked " + url.href }, 599);
};

export const post = (path, body, headers = {}) => new Request(ORIGIN + path, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
export const get = (path, headers = {}) => new Request(ORIGIN + path, { headers });
export const body = async (r) => ({ status: r.status, data: await r.json().catch(() => null) });
