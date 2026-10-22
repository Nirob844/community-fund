// Refunds, disputes, pledge management, closing payouts, personal-data tools,
// books export, fund closing and scale — against the real schema.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeDb, ids } from "./_setup.mjs";

let db;
const T = (q, p) => db.as("authenticated", ids.t, q, p);
const R = (q, p) => db.as("authenticated", ids.r, q, p);
const one = async (q, p) => (await db.query(q, p)).rows[0];
const ledger = async () => (await one("select public.public_ledger() j")).j;
const person = async (name, area = "Magnolia Point") =>
  (await T("insert into public.contributors(full_name, email, area, public_label) values ($1, $2, $3, $4) returning id",
    [name, name.toLowerCase().replace(/\W/g, "") + "@example.org", area, name.split(" ")[0] + " " + name.split(" ")[1][0] + "."])).rows[0].id;
const give = async (cid, amount, label = "X", extra = {}) =>
  (await T("insert into public.receipts(contributor_id, public_label, area, amount, method, received_on) values ($1,$2,'Magnolia Point',$3,$4,$5) returning id",
    [cid, label, amount, extra.method || "Check", extra.on || "2026-10-10"])).rows[0].id;
before(async () => { db = await makeDb(); });

test("a refund reduces net contributions and re-opens the pledge", async () => {
  const c = await person("Ann Adams");
  await T("insert into public.pledges(contributor_id, amount) values ($1, 100)", [c]);
  const rid = await give(c, 100, "Ann A.");
  assert.equal((await one("select status from public.pledges where contributor_id=$1", [c])).status, "paid");
  await T("insert into public.refunds(receipt_id, contributor_id, public_label, amount, kind, method, reason) values ($1,$2,'Ann A.',40,'refund','Check','Asked for partial refund')", [rid, c]);
  assert.equal((await one("select status from public.pledges where contributor_id=$1", [c])).status, "partial");
  const L = await ledger();
  assert.equal(Number(L.totals.receivedGross), 100); assert.equal(Number(L.totals.refunded), 40); assert.equal(Number(L.totals.received), 60);
  assert.equal(Number(L.totals.outstandingPledges), 40);
});

test("a refund can never exceed what is left of the receipt", async () => {
  const rid = (await one("select id from public.receipts where public_label='Ann A.'")).id;
  await assert.rejects(T("insert into public.refunds(receipt_id, amount, kind) values ($1, 61, 'refund')", [rid]), /more than what is left/);
});

test("only the treasurer can record refunds and payouts", async () => {
  await assert.rejects(R("insert into public.refunds(amount, kind) values (5, 'refund')"), /row-level security/);
});

test("a lost chargeback counts like a refund; a disputed receipt is flagged", async () => {
  const c = await person("Bob Brown", "Tuttle Avenue");
  const rid = await give(c, 50, "Bob B.", { method: "Online (Stripe)" });
  await T("update public.receipts set disputed = true where id=$1", [rid]);
  assert.equal(Number((await ledger()).totals.disputed), 50);
  await T("insert into public.refunds(receipt_id, contributor_id, public_label, amount, kind, method) values ($1,$2,'Bob B.',50,'dispute_lost','Stripe')", [rid, c]);
  assert.equal(Number((await ledger()).totals.refunded), 90);
});

test("pledges can be edited, withdrawn and cancelled; status and totals follow", async () => {
  const c = await person("Cy Cole", "Whitfield");
  const p = (await T("insert into public.pledges(contributor_id, amount) values ($1, 300) returning id", [c])).rows[0].id;
  await give(c, 100, "Cy C.");
  assert.equal((await one("select status from public.pledges where id=$1", [p])).status, "partial");
  await T("update public.pledges set amount = 100 where id=$1", [p]);
  assert.equal((await one("select status from public.pledges where id=$1", [p])).status, "paid");
  const p2 = (await T("insert into public.pledges(contributor_id, amount) values ($1, 500) returning id", [c])).rows[0].id;
  const before = Number((await ledger()).totals.outstandingPledges);
  await T("update public.pledges set status='withdrawn', note='Moved away' where id=$1", [p2]);
  assert.equal(Number((await ledger()).totals.outstandingPledges), before - 500);
  assert.equal((await one("select status from public.pledges where id=$1", [p2])).status, "withdrawn");
  await assert.rejects(R("update public.pledges set status='cancelled' where id=$1 returning id", [p]).then((r) => { if (!r.rows.length) throw new Error("row-level security"); }), /row-level security/);
});

test("correcting a contributor's public name updates every ledger line", async () => {
  const c = (await one("select id from public.contributors where full_name='Cy Cole'")).id;
  await T("update public.contributors set public_label='C. Cole', area='Whitfield Estates' where id=$1", [c]);
  const r = await one("select public_label, area from public.receipts where contributor_id=$1", [c]);
  assert.equal(r.public_label, "C. Cole"); assert.equal(r.area, "Whitfield Estates");
});

test("merging two records for one person moves all money and pledges", async () => {
  const a = await person("Dee Dunn"), b = await person("Dee Dunn2");
  await T("insert into public.pledges(contributor_id, amount) values ($1, 100)", [a]);
  await give(b, 100, "Dee D.");
  await T("select public.merge_contributors($1, $2)", [b, a]);
  assert.equal((await one("select count(*)::int n from public.contributors where id=$1", [b])).n, 0);
  assert.equal((await one("select status from public.pledges where contributor_id=$1", [a])).status, "paid");
  await assert.rejects(R("select public.merge_contributors($1, $1)", [a]), /not allowed/);
});

test("erasing a person removes their details everywhere, including audit history, but keeps the money", async () => {
  const c = await person("Eve Evans");
  await give(c, 25, "Eve E.");
  await db.query("insert into public.email_log(contributor_id, kind, to_email) values ($1, 'receipt', 'eveevans@example.org')", [c]);
  await assert.rejects(R("select public.anonymize_contributor($1)", [c]), /not allowed/);
  await T("select public.anonymize_contributor($1)", [c]);
  const row = await one("select full_name, email, address, public_label from public.contributors where id=$1", [c]);
  assert.deepEqual(row, { full_name: "[erased]", email: "", address: "", public_label: "Anonymous neighbor" });
  assert.equal((await one("select public_label from public.receipts where contributor_id=$1", [c])).public_label, "Anonymous neighbor");
  const audit = JSON.stringify((await db.query("select old_row, new_row from public.audit_log")).rows);
  assert.ok(!/Eve|eveevans/i.test(audit), "audit log still contains the person's details");
  assert.equal((await one("select to_email from public.email_log where contributor_id=$1", [c])).to_email, "");
  assert.equal((await one("select count(*)::int n from public.audit_log where op='ERASE' and row_id=$1", [c])).n, 1);
  assert.equal(Number((await one("select sum(amount) s from public.receipts where contributor_id=$1", [c])).s), 25);
});

test("the books export is a balanced double-entry journal and is staff-only", async () => {
  await T("insert into public.expenses(amount, payee, category, status) values (61.25,'Florida Dept. of State','Registration and filings','paid'), (500,'Law firm','Legal fees','unpaid')");
  const rows = (await T("select * from public.export_journal()")).rows;
  const dr = rows.reduce((a, r) => a + Number(r.debit), 0), cr = rows.reduce((a, r) => a + Number(r.credit), 0);
  assert.ok(rows.length > 10); assert.equal(dr.toFixed(2), cr.toFixed(2));
  await assert.rejects(db.as("authenticated", ids.x, "select * from public.export_journal()"), /not allowed/);
});

test("closing plan pays out exactly the pool, to the cent", async () => {
  const fresh = await makeDb(); const t = (q, p) => fresh.as("authenticated", ids.t, q, p);
  const cs = [];
  for (const n of ["Al A", "Bo B", "Cal C"]) cs.push((await t("insert into public.contributors(full_name, public_label, area) values ($1,$1,'MP') returning id", [n])).rows[0].id);
  for (const c of cs) await t("insert into public.receipts(contributor_id, public_label, amount, method) values ($1,'x',100,'Cash')", [c]);
  await t("insert into public.expenses(amount, payee, status) values (200,'Law firm','paid')");
  const plan = (await t("select * from public.closing_plan()")).rows;
  assert.deepEqual(plan.map((r) => Number(r.due)).sort(), [33.33, 33.33, 33.34]);
  assert.equal(plan.reduce((a, r) => a + Number(r.due), 0).toFixed(2), "100.00");
  await t("insert into public.refunds(contributor_id, amount, kind, method) values ($1, $2, 'closing_payout', 'Check')", [plan[0].contributor_id, plan[0].due]);
  const after = (await t("select * from public.closing_plan()")).rows.find((r) => r.contributor_id === plan[0].contributor_id);
  assert.equal(Number(after.remaining), 0); assert.equal(Number(after.paid_out), Number(plan[0].due));
  const L = (await fresh.query("select public.public_ledger() j")).rows[0].j;
  assert.equal(Number(L.totals.payouts), Number(plan[0].due));
  assert.equal(Number(L.totals.cash).toFixed(2), (100 - Number(plan[0].due)).toFixed(2));
  await assert.rejects(fresh.as("authenticated", ids.x, "select * from public.closing_plan()"), /not allowed/);
});

test("once the fund is closing, new pledges are refused", async () => {
  const fresh = await makeDb(); const t = (q, p) => fresh.as("authenticated", ids.t, q, p);
  const c = (await t("insert into public.contributors(full_name, public_label) values ('Z Z','Z Z') returning id")).rows[0].id;
  await t("update public.settings set fund_status='closing'");
  await assert.rejects(t("insert into public.pledges(contributor_id, amount) values ($1, 10)", [c]), /no longer accepting/);
  assert.equal((await fresh.query("select public.public_ledger() j")).rows[0].j.org.acceptOnline, false);
});

test("my_share returns a person's own figures and nothing for a bad token", async () => {
  const tok = (await one("select share_token from public.contributors where full_name='Ann Adams'")).share_token;
  const s = (await one("select public.my_share($1) j", [tok])).j;
  assert.equal(s.label, "Ann A."); assert.equal(Number(s.received), 60);
  assert.equal((await one("select public.my_share('nope') j")).j, null);
  await assert.rejects(db.as("authenticated", ids.t, "select public.my_share($1)", [tok]), /permission denied/);
});

test("scale: totals stay exact and fast with 20,000 receipts (no 1,000-row cap)", async () => {
  const fresh = await makeDb();
  await fresh.exec(`insert into public.contributors(id, full_name, public_label, area)
      select gen_random_uuid(), 'P' || g, 'P' || g, case when g % 3 = 0 then 'Magnolia Point' when g % 3 = 1 then 'Tuttle Avenue' else 'Whitfield' end
      from generate_series(1, 10000) g;
    insert into public.receipts(contributor_id, public_label, area, amount, method, received_on)
      select c.id, c.public_label, c.area, 10, 'Check', date '2026-01-01' + (g % 280)
      from public.contributors c cross join generate_series(1, 2) g;`);
  const t0 = Date.now();
  const L = (await fresh.query("select public.public_ledger() j")).rows[0].j;
  const ms = Date.now() - t0;
  assert.equal(Number(L.totals.received), 200000);
  assert.equal(L.receiptsTotal, 20000); assert.equal(L.peopleTotal, 10000);
  assert.equal(L.areas.reduce((a, x) => a + Number(x.received), 0), 200000);
  assert.equal(L.people.length, 1000, "per-person list is capped; totals still cover everyone");
  assert.ok(ms < 3000, `too slow: ${ms} ms`);
  assert.equal(L.receipts.length, 100, "recent list is capped for page size");
  assert.ok(JSON.stringify(L).length < 400000, "payload stays small");
  console.log(`    public_ledger over 20,000 receipts: ${ms} ms, ${(JSON.stringify(L).length / 1024).toFixed(0)} KB`);
});
