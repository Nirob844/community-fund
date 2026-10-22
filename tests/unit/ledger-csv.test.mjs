import { reset, state, get } from "./_mock.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const csv = (await import("../../netlify/functions/ledger-csv.mjs")).default;

test("full ledger CSV pages through every row (2,500 receipts), public columns only", async () => {
  const receipts = Array.from({ length: 2500 }, (_, i) => ({ id: String(i).padStart(5, "0"), received_on: "2026-10-10", public_label: "N" + i, area: "MP", method: "Check", amount: "10", reference: "SECRET-REF", contributor_id: "C" }));
  reset({ receipts, refunds: [{ id: "f1", refunded_on: "2026-10-11", public_label: "N1", area: "MP", kind: "refund", method: "Check", reason: "", amount: "5" }], expenses: [] });
  // make the mock honour .range() like Supabase (max 1,000 rows per request)
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const url = new URL(String(u)); const r = await real(u, i);
    if (!url.pathname.includes("/rest/v1/")) return r;
    const rows = await r.json();
    const off = Number(url.searchParams.get("offset") || 0), lim = Math.min(Number(url.searchParams.get("limit") || 1000), 1000);
    const out = Array.isArray(rows) ? rows.slice(off, off + lim) : rows;
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const r = await csv(get("/api/ledger-csv"));
    const text = await r.text();
    assert.match(r.headers.get("content-disposition"), /attachment/);
    assert.equal(text.split("\r\n").filter((l) => l.startsWith('"contribution"')).length, 2500);
    assert.ok(text.includes('"refund"'));
    assert.ok(!text.includes("SECRET-REF"));
  } finally { globalThis.fetch = real; }
});
test("spreadsheet formula injection is neutralised", async () => {
  reset({ receipts: [{ id: "1", received_on: "2026-10-10", public_label: "=HYPERLINK(\"http://evil\")", area: "MP", method: "Check", amount: "1" }], refunds: [], expenses: [] });
  const text = await (await csv(get("/api/ledger-csv"))).text();
  assert.ok(text.includes(`"'=HYPERLINK`));
});
