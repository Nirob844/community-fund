import { $, h, fill, fmt, emptyRow, live, renderTiles, renderFooterLegal } from "./common.js";

const today = () => new Date().toISOString().slice(0, 10);
const line = (label, v, cls) => h("tr", { class: cls || null }, h("td", {}, label), h("td", { class: "r num" }, fmt(Number(v))));
const head = (label) => h("tr", { class: "subh" }, h("td", { colspan: 2 }, label));
const KIND = { refund: "Refund", dispute_lost: "Card chargeback", closing_payout: "Returned at closing" };
const more = (id, shown, total, what) => { const el = $(id); el.hidden = !(total > shown); el.textContent = `Showing the latest ${shown} of ${total.toLocaleString()} ${what}. Download the full ledger for every entry.`; };

function render(d) {
  const t = d.totals;
  renderTiles(t);
  renderFooterLegal(d.org);
  $("updated").textContent = "Updated " + new Date(d.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });

  fill($("incomeRows"), d.receipts.length
    ? [...d.receipts.map((r) => h("tr", {}, h("td", { class: "num" }, r.date), h("td", {}, r.label), h("td", {}, r.area), h("td", {}, r.method, r.disputed ? [" ", h("span", { class: "pill due" }, "Under dispute")] : null), h("td", { class: "r num" }, fmt(Number(r.amount))))),
       h("tr", { class: "total" }, h("td", { colspan: 4 }, "Total received (before refunds)"), h("td", { class: "r num" }, fmt(Number(t.receivedGross))))]
    : emptyRow(5, "No contributions received yet."));
  more("incomeMore", d.receipts.length, d.receiptsTotal || 0, "contributions");

  const outs = d.people.filter((p) => Number(p.outstanding) > 0);
  fill($("pledgeRows"), outs.length
    ? outs.map((p) => h("tr", {}, h("td", {}, p.label), h("td", {}, p.area), h("td", { class: "r num" }, fmt(Number(p.pledged))), h("td", { class: "r num" }, fmt(Number(p.received))), h("td", { class: "r" }, h("span", { class: "pill pend num" }, fmt(Number(p.outstanding))))))
    : emptyRow(5, "No outstanding pledges."));

  fill($("refundRows"), (d.refunds || []).length
    ? d.refunds.map((r) => h("tr", {}, h("td", { class: "num" }, r.date), h("td", {}, r.label), h("td", {}, r.area), h("td", {}, KIND[r.kind] || r.kind), h("td", { class: "r num" }, fmt(-Number(r.amount)))))
    : emptyRow(5, "No refunds or payouts."));

  fill($("expenseRows"), d.expenses.length
    ? [...d.expenses.map((e) => h("tr", {}, h("td", { class: "num" }, e.date), h("td", {}, e.payee), h("td", {}, e.category), h("td", {}, e.description),
        h("td", {}, h("span", { class: e.status === "unpaid" ? "pill due" : "pill ok" }, e.status === "unpaid" ? "Unpaid" : "Paid")), h("td", { class: "r num" }, fmt(Number(e.amount))))),
       h("tr", { class: "total" }, h("td", { colspan: 5 }, "Total expenses"), h("td", { class: "r num" }, fmt(Number(t.expenses))))]
    : emptyRow(6, "No expenses recorded yet."));
  more("expenseMore", d.expenses.length, d.expensesTotal || 0, "expenses");

  // Income statement
  const first = (d.months || []).map((m) => m.month).sort()[0];
  $("isAsOf").textContent = first ? `From ${first} to ${today()}` : "From inception to today";
  $("bsAsOf").textContent = "As of " + today();
  const net = Number(t.received) - Number(t.expenses);
  fill($("incomeStmt"),
    head("Revenue"),
    (d.methods || []).length ? d.methods.map((m) => line("Contributions: " + m.method, m.amount)) : line("Contributions", 0),
    line("Gross contributions", t.receivedGross, "subh"),
    Number(t.refunded) ? line("Less refunds and chargebacks", -Number(t.refunded)) : null,
    line("Net contributions", t.received, "subh"),
    head("Expenses"),
    (d.categories || []).length ? d.categories.map((c) => line(c.category, c.amount)) : line("None recorded", 0),
    line("Total expenses", t.expenses, "subh"),
    line(net >= 0 ? "Net surplus" : "Net deficit", net, "total"),
    Number(t.payouts) ? line("Returned to contributors at closing", -Number(t.payouts)) : null);

  // Balance sheet
  fill($("balanceSheet"),
    head("Assets"), line("Cash", t.cash), line("Total assets", t.cash, "subh"),
    head("Liabilities"), line("Unpaid bills", t.expensesUnpaid), line("Total liabilities", t.expensesUnpaid, "subh"),
    line("Net assets", Number(t.cash) - Number(t.expensesUnpaid), "total"),
    h("tr", {}, h("td", { colspan: 2, class: "hint" }, `Outstanding pledges of ${fmt(Number(t.outstandingPledges))} are not counted as assets until received.` + (Number(t.disputed) ? ` ${fmt(Number(t.disputed))} of card payments is under dispute.` : ""))));

  // Refund shares
  $("sRec").textContent = fmt(Number(t.received)); $("sExp").textContent = fmt(Number(t.expenses) + Number(t.payouts || 0)); $("sPool").textContent = fmt(Number(t.availableToReturn));
  const sh = d.people.filter((p) => Number(p.received) > 0);
  fill($("shareRows"), sh.length
    ? sh.map((p) => h("tr", {}, h("td", {}, p.label), h("td", {}, p.area), h("td", { class: "r num" }, fmt(Number(p.received))),
        h("td", {}, h("div", { class: "sharebar" }, h("div", { class: "b" }, h("span", { style: { width: (p.share * 100).toFixed(2) + "%" } })), h("span", { class: "num hint" }, (p.share * 100).toFixed(1) + "%"))),
        h("td", { class: "r num" }, fmt(Number(p.refund)))))
    : emptyRow(5, "Shares appear here once contributions are received."));
  more("shareMore", sh.length, d.peopleTotal || 0, "contributors");
}

live(render, () => { const s = $("status"); s.textContent = "Live figures are temporarily unavailable. Please refresh in a minute."; s.hidden = false; });
