// v3.2: giving plans, treasurer limits and goals, developer access and handover,
// activity log, and the function lockdown. Runs against the real schema in Postgres.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { makeDb, ids } from "./_setup.mjs";

let db;
const T = (q, p) => db.as("authenticated", ids.t, q, p);       // treasurer
const R = (q, p) => db.as("authenticated", ids.r, q, p);       // recorder
const A = (q, p) => db.as("authenticated", ids.a, q, p);       // auditor
const S = (q, p) => db.as("service_role", null, q, p);         // the server
const ANON = (q, p) => db.as("anon", null, q, p);
const DEV = "66666666-6666-4666-8666-666666666666";
const D = (q, p) => db.as("authenticated", DEV, q, p);         // developer
const one = async (q, p) => (await db.query(q, p)).rows[0];
let cid;

before(async () => {
  db = await makeDb();
  await db.query("insert into auth.users values ($1, 'dev@example.org')", [DEV]);
  cid = (await T("insert into public.contributors(full_name, email, public_label, area) values ('Maria Gomez','m@example.org','Maria G.','Magnolia Point') returning id")).rows[0].id;
});

// ---------- Limits and goals ----------
test("the treasurer can raise and lower gift and deposit limits; nobody else can", async () => {
  await T("update public.settings set min_gift = 10, max_gift = 500, max_pledge = 5000, max_deposit = 1000");
  let s = await one("select min_gift, max_gift, max_pledge, max_deposit from public.settings");
  assert.deepEqual([s.min_gift, s.max_gift, s.max_pledge, s.max_deposit].map(Number), [10, 500, 5000, 1000]);
  assert.equal((await R("update public.settings set max_deposit = 999999 returning id")).rows.length, 0, "recorder's update must change nothing");
  assert.equal((await A("update public.settings set max_deposit = 999999 returning id")).rows.length, 0);
  await assert.rejects(T("update public.settings set min_gift = 600"), /settings_limits|check/, "minimum above maximum");
  await assert.rejects(T("update public.settings set max_gift = 3000000"), /settings_limits|check/);
  await assert.rejects(T("update public.settings set suggested_amounts = '[0, 10]'"), /settings_amounts|check/);
  await assert.rejects(T("update public.settings set suggested_amounts = '\"lots\"'"), /settings_amounts|check/);
  await T("update public.settings set suggested_amounts = '[10, 20, 40]'");
});

test("website pledges and hand-recorded deposits obey the limits; card payments are always recorded", async () => {
  const cid = (await T("insert into public.contributors(full_name, public_label, area) values ('Lim Its','Lim I.','Whitfield') returning id")).rows[0].id;
  await assert.rejects(T("insert into public.pledges(contributor_id, amount, source) values ($1, 6000, 'website')", [cid]), /between 10.00 and 5000.00/);
  await assert.rejects(T("insert into public.pledges(contributor_id, amount, source) values ($1, 5, 'website')", [cid]), /between/);
  await T("insert into public.pledges(contributor_id, amount, source) values ($1, 6000, 'staff')", [cid]);  // staff pledges: no website limit
  await assert.rejects(R("insert into public.receipts(contributor_id, public_label, amount, method) values ($1,'Maria G.',1500,'Check')", [cid]), /above the 1000.00 limit/);
  await assert.rejects(T("insert into public.receipts(contributor_id, public_label, amount, method) values ($1,'Maria G.',1500,'Check')", [cid]), /limit/, "the limit binds the treasurer too until raised");
  await S("insert into public.receipts(contributor_id, public_label, amount, method, stripe_invoice_id) values ($1,'Maria G.',1500,'Online (Stripe)','in_big')", [cid]);
  await T("update public.settings set max_deposit = 2000");
  await R("insert into public.receipts(contributor_id, public_label, amount, method) values ($1,'Maria G.',1500,'Check')", [cid]);
  await T("update public.settings set min_gift = 5, max_gift = 10000, max_pledge = 2000000, max_deposit = 250000");
});

test("goals can be raised, lowered, added and removed, but never made invalid", async () => {
  await T(`update public.settings set milestones = '[{"amount":15000,"title":"Attorney and experts","desc":""},{"amount":2500000,"title":"Buy the land","desc":"Park"}]'`);
  const L = (await one("select public.public_ledger_v2() j")).j;
  assert.deepEqual(L.milestones.map((m) => m.amount), [15000, 2500000]);
  for (const bad of ['[]', '[{"amount":0,"title":"x"}]', '[{"amount":100,"title":""}]', '[{"amount":"100","title":"x"}]', '{"amount":1}']) {
    await assert.rejects(T(`update public.settings set milestones = '${bad}'`), /settings_milestones|check/, bad);
  }
});

test("the public ledger carries the limits, the goal settings and giving-plan totals", async () => {
  await T("update public.settings set prompts_enabled = true, prompt_headline = 'Help us reach the attorney goal', goal_deadline = '2026-12-31'");
  const L = (await one("select public.public_ledger_v2() j")).j;
  assert.equal(Number(L.limits.minGift), 5); assert.equal(Number(L.limits.maxGift), 10000);
  assert.equal(L.limits.allowPlans, false, "plans are offered only when card payments are open");
  assert.deepEqual(L.limits.suggestedAmounts, [10, 20, 40]);
  assert.equal(L.goal.headline, "Help us reach the attorney goal"); assert.equal(L.goal.deadline, "2026-12-31");
  assert.equal(Number(L.plans.active), 0);
  await assert.rejects(T("update public.settings set prompt_headline = repeat('x', 200)"), /check/);
});

// ---------- Giving plans ----------
let plan;
test("the server opens a card giving plan within the limits", async () => {
  await T("update public.settings set fdacs_reg = 'CH12345', accept_online = true");
  const pid = (await S("insert into public.pledges(contributor_id, amount, note) values ($1, 150, 'Giving plan: 25 monthly x 6') returning id", [cid])).rows[0].id;
  plan = (await S("insert into public.giving_plans(contributor_id, pledge_id, installment, frequency, payments) values ($1,$2,25,'monthly',6) returning *", [cid, pid])).rows[0];
  assert.equal(plan.status, "pending");
  await assert.rejects(S("insert into public.giving_plans(contributor_id, installment, frequency, payments) values ($1, 25, 'monthly', 99)", [cid]), /at most 24 payments/);
  await assert.rejects(S("insert into public.giving_plans(contributor_id, installment, frequency, payments) values ($1, 2, 'monthly', 6)", [cid]), /between 5.00 and 10000.00/);
  await T("update public.settings set allow_plans = false");
  await assert.rejects(S("insert into public.giving_plans(contributor_id, installment, frequency, payments) values ($1, 25, 'weekly', 6)", [cid]), /switched off/);
  await T("update public.settings set allow_plans = true");
  const L = (await one("select public.public_ledger_v2() j")).j;
  assert.equal(L.limits.allowPlans, true);
});

test("staff can't create card plans; recorders can add hand-collected plans", async () => {
  await assert.rejects(R("insert into public.giving_plans(contributor_id, installment, frequency, payments, method) values ($1, 25, 'monthly', 6, 'card')", [cid]), /row-level security/);
  await assert.rejects(A("insert into public.giving_plans(contributor_id, installment, frequency, payments, method) values ($1, 25, 'monthly', 6, 'manual')", [cid]), /row-level security/);
  const m = (await R("insert into public.giving_plans(contributor_id, installment, frequency, payments, method) values ($1, 50, 'quarterly', 4, 'manual') returning status", [cid])).rows[0];
  assert.equal(m.status, "pending");
  assert.equal((await D("select * from public.giving_plans")).rows.length, 0, "developer never sees plans");
});

test("each payment counts toward the plan, which completes itself after the last one", async () => {
  for (let i = 1; i <= 5; i++) {
    await S("insert into public.receipts(contributor_id, pledge_id, plan_id, public_label, amount, method, stripe_invoice_id, received_on) values ($1,$2,$3,'Maria G.',25,'Online (Stripe)',$4, current_date)", [cid, plan.pledge_id, plan.id, "in_" + i]);
  }
  let p = await one("select * from public.giving_plans where id = $1", [plan.id]);
  assert.equal(p.paid_count, 5); assert.equal(Number(p.paid_total), 125); assert.equal(p.status, "active");
  await assert.rejects(S("insert into public.receipts(contributor_id, plan_id, public_label, amount, method, stripe_invoice_id) values ($1,$2,'x',25,'Online (Stripe)','in_1')", [cid, plan.id]), /duplicate|unique/, "a retried invoice is never counted twice");
  await S("insert into public.receipts(contributor_id, pledge_id, plan_id, public_label, amount, method, stripe_invoice_id) values ($1,$2,$3,'Maria G.',25,'Online (Stripe)','in_6')", [cid, plan.pledge_id, plan.id]);
  p = await one("select status, paid_count from public.giving_plans where id = $1", [plan.id]);
  assert.equal(p.status, "completed"); assert.equal(p.paid_count, 6);
  const nd = await one("select public.plan_next_due(p) d from public.giving_plans p where id = $1", [plan.id]);
  assert.equal(nd.d, null, "a finished plan has no next payment");
  await T("delete from public.receipts where stripe_invoice_id = 'in_6'");
  assert.equal((await one("select status from public.giving_plans where id = $1", [plan.id])).status, "active", "removing a payment reopens it");
});

test("stopping a plan shrinks the pledge to what was given; only the treasurer or server can", async () => {
  await assert.rejects(R("select public.cancel_plan($1, 'x')", [plan.id]), /not allowed/);
  await assert.rejects(D("select public.cancel_plan($1, 'x')", [plan.id]), /not allowed/);
  const r = (await S("select public.cancel_plan($1, 'Donor asked') r", [plan.id])).rows[0].r;
  assert.equal(r.status, "cancelled");
  const p = await one("select amount, status, note from public.pledges where id = $1", [plan.pledge_id]);
  assert.equal(Number(p.amount), 125); assert.equal(p.status, "paid"); assert.match(p.note, /stopped after 5/);
  const again = (await T("select public.cancel_plan($1) r", [plan.id])).rows[0].r;
  assert.equal(again.changed, false);
});

test("a donor's private page lists their plans with the next payment date", async () => {
  const tok = (await one("select share_token from public.contributors where id = $1", [cid])).share_token;
  const m = (await S("select public.my_share_v2($1) j", [tok])).rows[0].j;
  assert.equal(m.plans.length, 2);
  const manual = m.plans.find((x) => x.method === "manual");
  assert.equal(manual.frequency, "quarterly"); assert.ok(manual.nextDue, "pending plan has a next date");
  assert.equal(m.plans.find((x) => x.method === "card").status, "cancelled");
  assert.equal(Number(m.limits.maxGift), 10000);
  await assert.rejects(ANON("select public.my_share_v2($1)", [tok]), /permission denied/);
  await assert.rejects(T("select public.my_share_v2($1)", [tok]), /permission denied/, "only the server looks up private links");
});

// ---------- Developer access ----------
test("developer access must be temporary, one at a time, and doesn't take a team seat", async () => {
  await assert.rejects(db.query("insert into public.admins(user_id, role, display_name) values ($1,'developer','Dev')", [DEV]), /admins_dev_expiry|check|30 days/);
  await assert.rejects(db.query("insert into public.admins(user_id, role, display_name, access_expires_at) values ($1,'developer','Dev', now() + interval '45 days')", [DEV]), /within 30 days/);
  await db.query("insert into public.admins(user_id, role, display_name, access_expires_at, purpose) values ($1,'developer','Dev', now() + interval '7 days', 'Fix receipt emails')", [DEV]);
  const other = "77777777-7777-4777-8777-777777777777";
  await db.query("insert into auth.users values ($1, 'dev2@example.org')", [other]);
  await assert.rejects(db.query("insert into public.admins(user_id, role, display_name, access_expires_at) values ($1,'developer','Dev2', now() + interval '1 day')", [other]), /one developer/);
  assert.equal((await D("select public.staff_role() r")).rows[0].r, "developer");
});

test("a developer sees settings, health checks and the activity log, but no people, money or history", async () => {
  for (const t of ["contributors", "pledges", "receipts", "refunds", "expenses", "audit_log", "email_log", "giving_plans"]) {
    assert.equal((await D(`select * from public.${t}`)).rows.length, 0, t + " must be invisible");
  }
  assert.equal((await D("select id from public.settings")).rows.length, 1);
  assert.ok((await D("select count(*)::int n from public.activity_log")).rows[0].n > 0);
  assert.equal((await D("update public.settings set max_gift = 1 returning id")).rows.length, 0, "read only");
  await assert.rejects(D("insert into public.contributors(full_name, public_label) values ('x','x')"), /row-level security/);
  await assert.rejects(D("select * from public.closing_plan()"), /not allowed/);
  await assert.rejects(D("select * from public.export_journal()"), /not allowed/);
  await assert.rejects(D("select public.anonymize_contributor($1)", [cid]), /not allowed/);
  assert.equal((await D("select public.audit_verify() v")).rows[0].v.ok, true);
  assert.equal((await D("select public.security_audit() s")).rows[0].s.ok, true);
  assert.equal((await D("select user_id from public.admins")).rows.length, 1, "sees only their own team row");
});

test("expired developer access stops working on its own", async () => {
  await db.exec("alter table public.admins disable trigger staff_rules");
  await db.query("update public.admins set access_expires_at = now() - interval '1 minute' where user_id = $1", [DEV]);
  await db.exec("alter table public.admins enable trigger staff_rules");
  assert.equal((await D("select public.staff_role() r")).rows[0].r, null);
  assert.equal((await D("select id from public.settings")).rows.length, 0);
  await assert.rejects(D("select public.security_audit()"), /not allowed/);
  await db.query("update public.admins set access_expires_at = now() + interval '2 days' where user_id = $1", [DEV]);
  assert.equal((await D("select public.staff_role() r")).rows[0].r, "developer");
});

test("confirming the handover removes every developer immediately and is logged", async () => {
  await T("update public.settings set handover_at = now(), keys_rotated_on = current_date");
  assert.equal((await one("select active from public.admins where user_id = $1", [DEV])).active, false);
  assert.equal((await D("select public.staff_role() r")).rows[0].r, null);
  const s = await one("select handover_by from public.settings");
  assert.equal(s.handover_by, ids.t);
  const acts = (await db.query("select action, level from public.activity_log order by id")).rows.map((r) => r.action);
  assert.ok(acts.includes("handover.complete")); assert.ok(acts.includes("team.deactivate"));
  // the treasurer may invite a developer again later
  await db.query("update public.admins set active = true, access_expires_at = now() + interval '1 day' where user_id = $1", [DEV]);
  assert.equal((await D("select public.staff_role() r")).rows[0].r, "developer");
});

// ---------- Activity log ----------
test("the activity log records team, limits and payment-setting changes by itself", async () => {
  const rows = (await db.query("select action, level, actor from public.activity_log")).rows;
  const acts = new Set(rows.map((r) => r.action));
  for (const a of ["team.add", "settings.limits", "settings.goals", "settings.payments"]) assert.ok(acts.has(a), a);
  assert.ok(rows.some((r) => r.action === "settings.limits" && r.actor === ids.t), "stamped with who did it");
});

test("staff browsers can add only a few kinds of entry, always stamped with their own identity", async () => {
  await R("select public.log_activity('client.sign_in', '{\"page\":\"admin\",\"actor\":\"someone else\",\"secret\":\"x\"}')");
  const r = await one("select * from public.activity_log order by id desc limit 1");
  assert.equal(r.actor, ids.r); assert.equal(r.role, "recorder"); assert.equal(r.actor_label, "r@example.org");
  assert.deepEqual(r.detail, { page: "admin" }, "unknown fields are dropped");
  await assert.rejects(R("select public.log_activity('team.add', '{}')"), /Unknown activity/);
  await assert.rejects(db.as("authenticated", ids.x, "select public.log_activity('client.sign_in', '{}')"), /not allowed/, "not on the team");
  await assert.rejects(ANON("select public.log_activity('client.sign_in', '{}')"), /permission denied/);
});

// ---------- Lockdown ----------
test("the public key can run no function and read no table; outsiders get nothing", async () => {
  const fns = (await db.query(`select p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
     where s.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and has_function_privilege('anon', p.oid, 'execute')`)).rows;
  assert.deepEqual(fns, [], "anon can execute: " + fns.map((f) => f.proname).join(", "));
  for (const f of ["public_ledger()", "public_ledger_v2()", "ledger_totals()", "security_audit()", "staff_role()"]) {
    await assert.rejects(ANON(`select public.${f}`), /permission denied/, f);
  }
  const X = (q) => db.as("authenticated", ids.x, q);       // signed in, but not on the team
  for (const t of ["contributors", "settings", "activity_log", "giving_plans", "admins"]) assert.equal((await X(`select * from public.${t}`)).rows.length, 0, t);
  await assert.rejects(X("select public.security_audit()"), /not allowed/);
  await assert.rejects(X("select public.audit_verify()"), /not allowed/);
});

test("the security self-check passes, and spots a weakness if one is introduced", async () => {
  let s = (await T("select public.security_audit() s")).rows[0].s;
  assert.equal(s.ok, true, JSON.stringify(s.checks.filter((c) => !c.ok)));
  assert.ok(s.checks.length >= 10);
  await assert.rejects(R("select public.security_audit()"), /not allowed/);
  await db.exec("grant execute on function public.closing_plan() to anon");
  s = (await T("select public.security_audit() s")).rows[0].s;
  assert.equal(s.ok, false);
  assert.match(JSON.stringify(s.checks.find((c) => !c.ok)), /closing_plan/);
  await db.exec("revoke execute on function public.closing_plan() from anon");
});

test("the server writes activity entries; nobody can change or delete them; tampering is detected", async () => {
  await S("insert into public.activity_log(action, level, path, detail) values ('access.denied','security','/api/staff','{\"reason\":\"not staff\"}')");
  await assert.rejects(S("update public.activity_log set level = 'info'"), /permission denied/);
  await assert.rejects(S("delete from public.activity_log"), /permission denied/);
  await assert.rejects(T("delete from public.activity_log"), /permission denied/);
  await assert.rejects(db.query("update public.activity_log set level = 'info' where id = 1"), /cannot be changed/);
  await assert.rejects(db.query("truncate public.activity_log"), /cannot be changed/);
  await assert.rejects(T("insert into public.activity_log(action) values ('fake.entry')"), /permission denied/);
  assert.equal((await T("select public.activity_verify() v")).rows[0].v.ok, true);
  await db.exec("alter table public.activity_log disable trigger activity_guard");
  await db.query("update public.activity_log set level = 'info' where action = 'access.denied'");
  await db.exec("alter table public.activity_log enable trigger activity_guard");
  const v = (await T("select public.activity_verify() v")).rows[0].v;
  assert.equal(v.ok, false); assert.ok(v.firstBadId > 0);
});

test("upgrade from v3.1 keeps the books and the audit chain, and adds the new parts", async () => {
  const u = new PGlite({ extensions: { pgcrypto } });
  await u.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users (id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role; grant execute on function auth.uid() to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;`);
  await u.exec(readFileSync(new URL("./fixtures/schema_v31.sql", import.meta.url), "utf8"));
  await u.exec(`insert into auth.users values ('11111111-1111-4111-8111-111111111111','t@example.org');
    insert into public.admins(user_id, role, display_name) values ('11111111-1111-4111-8111-111111111111','treasurer','Tess');
    insert into public.contributors(id, full_name, public_label, area) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ann A','Ann A.','Magnolia Point');
    insert into public.pledges(contributor_id, amount) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 100);
    insert into public.receipts(contributor_id, public_label, area, amount, method) values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','Ann A.','Magnolia Point',60,'Check');`);
  const sql = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
  await u.exec(sql); await u.exec(sql);
  const L = (await u.query("select public.public_ledger_v2() j")).rows[0].j;
  assert.equal(Number(L.totals.received), 60); assert.equal(Number(L.limits.maxGift), 10000);
  await u.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
  assert.equal((await u.query("select public.audit_verify() v")).rows[0].v.ok, true);
  assert.equal((await u.query("select public.security_audit() s")).rows[0].s.ok, true);
});
