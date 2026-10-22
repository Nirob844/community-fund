// Row Level Security, staff rules and pledge status, against the real schema.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeDb, ids } from "./_setup.mjs";

let db;
const as = (...a) => db.as(...a);
const fails = async (p, re) => { await assert.rejects(p, re); };
before(async () => { db = await makeDb(); });

test("anonymous visitors cannot read or write any table", async () => {
  for (const t of ["contributors", "pledges", "receipts", "expenses", "settings", "admins", "audit_log", "refunds", "posts", "email_log"]) {
    await fails(as("anon", null, `select * from public.${t}`), /permission denied/);
  }
  await fails(as("anon", null, "insert into public.receipts(amount) values (5)"), /permission denied/);
});

test("signed-in non-staff see nothing and cannot write", async () => {
  const r = await as("authenticated", ids.x, "select * from public.contributors");
  assert.equal(r.rows.length, 0);
  await fails(as("authenticated", ids.x, "insert into public.contributors(full_name, public_label) values ('X','X')"), /row-level security/);
});

test("recorder records a pledge and a deposit; status flows open → partial → paid", async () => {
  const c = await as("authenticated", ids.r, "insert into public.contributors(full_name, email, area, public_label) values ('Maria Gomez','maria@example.org','Magnolia Point','Maria G.') returning id");
  const cid = c.rows[0].id;
  await as("authenticated", ids.r, "insert into public.pledges(contributor_id, amount, source) values ($1, 100, 'staff')", [cid]);
  const st = async () => (await db.query("select status from public.pledges where contributor_id=$1", [cid])).rows[0].status;
  assert.equal(await st(), "open");
  await as("authenticated", ids.r, "insert into public.receipts(contributor_id, public_label, area, amount, method, deposit_ref) values ($1,'Maria G.','Magnolia Point',60,'Check','DEP-1')", [cid]);
  assert.equal(await st(), "partial");
  await as("authenticated", ids.r, "insert into public.receipts(contributor_id, public_label, area, amount, method) values ($1,'Maria G.','Magnolia Point',40,'Cash')", [cid]);
  assert.equal(await st(), "paid");
  // a second pledge stays open until more money arrives (oldest pledge filled first)
  await as("authenticated", ids.r, "insert into public.pledges(contributor_id, amount, source, pledged_on) values ($1, 50, 'staff', current_date + 1)", [cid]);
  const rows = (await db.query("select amount::int, status from public.pledges where contributor_id=$1 order by pledged_on", [cid])).rows;
  assert.deepEqual(rows.map((x) => x.status), ["paid", "open"]);
});

test("deleting a deposit re-opens the pledge", async () => {
  const cid = (await db.query("select id from public.contributors where email='maria@example.org'")).rows[0].id;
  const rid = (await db.query("select id from public.receipts where contributor_id=$1 and method='Cash'", [cid])).rows[0].id;
  await as("authenticated", ids.t, "delete from public.receipts where id=$1", [rid]);
  const s = (await db.query("select status from public.pledges where contributor_id=$1 order by pledged_on limit 1", [cid])).rows[0].status;
  assert.equal(s, "partial");
});

test("recorder cannot add expenses, edit, delete, change settings or fake Stripe receipts", async () => {
  await fails(as("authenticated", ids.r, "insert into public.expenses(amount, payee) values (10,'X')"), /row-level security/);
  const del = await as("authenticated", ids.r, "delete from public.receipts returning id");
  assert.equal(del.rows.length, 0);
  const upd = await as("authenticated", ids.r, "update public.receipts set amount = 1 returning id");
  assert.equal(upd.rows.length, 0);
  const s = await as("authenticated", ids.r, "update public.settings set org_name='Hacked' returning id");
  assert.equal(s.rows.length, 0);
  await fails(as("authenticated", ids.r, "insert into public.receipts(amount, stripe_session_id) values (5,'cs_fake')"), /row-level security/);
});

test("auditor can read everything but change nothing", async () => {
  const r = await as("authenticated", ids.a, "select count(*)::int n from public.receipts");
  assert.ok(r.rows[0].n > 0);
  await fails(as("authenticated", ids.a, "insert into public.pledges(contributor_id, amount) select id, 5 from public.contributors limit 1"), /row-level security/);
});

test("treasurer can add expenses and update settings", async () => {
  await as("authenticated", ids.t, "insert into public.expenses(amount, payee, category) values (61.25,'Florida Dept. of State','Registration and filings')");
  const s = await as("authenticated", ids.t, "update public.settings set gofundme_url='https://gofund.me/x' returning id");
  assert.equal(s.rows.length, 1);
});

test("database rejects bad values", async () => {
  await fails(as("authenticated", ids.t, "insert into public.receipts(amount) values (-5)"), /check/);
  await fails(as("authenticated", ids.t, "insert into public.pledges(contributor_id, amount) select id, 3000000 from public.contributors limit 1"), /check|between/);
  await fails(as("authenticated", ids.t, "insert into public.receipts(amount, method) values (5,'Bitcoin')"), /check/);
  await fails(as("authenticated", ids.t, "update public.settings set gofundme_url='http://insecure'"), /check/);
});

test("staff limit is 5 active people and the last treasurer cannot be removed", async () => {
  for (let i = 0; i < 2; i++) {
    const id = `55555555-5555-4555-8555-55555555555${i}`;
    await db.query("insert into auth.users values ($1,$2)", [id, `s${i}@example.org`]);
    await db.query("insert into public.admins(user_id, role) values ($1,'recorder')", [id]);
  }
  await db.query("insert into auth.users values ('66666666-6666-4666-8666-666666666666','six@example.org')");
  await fails(db.query("insert into public.admins(user_id, role) values ('66666666-6666-4666-8666-666666666666','recorder')"), /at most 5/);
  await fails(db.query("update public.admins set role='recorder' where user_id=$1", [ids.t]), /at least one active treasurer/);
  await fails(db.query("delete from public.admins where user_id=$1", [ids.t]), /at least one active treasurer/);
  // deactivating someone frees a seat
  await db.query("update public.admins set active=false where user_id='55555555-5555-4555-8555-555555555551'");
  await db.query("insert into public.admins(user_id, role) values ('66666666-6666-4666-8666-666666666666','recorder')");
});

test("a deactivated staff member loses access immediately", async () => {
  const r = await as("authenticated", "55555555-5555-4555-8555-555555555551", "select * from public.contributors");
  assert.equal(r.rows.length, 0);
});

test("staff cannot grant themselves roles or edit the audit log", async () => {
  await fails(as("authenticated", ids.r, "update public.admins set role='treasurer' where user_id=$1", [ids.r]), /permission denied/);
  await fails(as("authenticated", ids.t, "delete from public.audit_log"), /permission denied/);
});

test("every change is audited with the person who made it", async () => {
  const r = await db.query("select count(*)::int n from public.audit_log where actor=$1 and table_name='receipts'", [ids.r]);
  assert.ok(r.rows[0].n >= 2);
});
