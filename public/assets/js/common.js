// Shared helpers. ES module, no dependencies, CSP-safe (no innerHTML with data, no inline styles).
export const $ = (id) => document.getElementById(id);
export const fmt = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmt0 = (n) => "$" + Math.round(n).toLocaleString("en-US");

/** Build DOM safely: h("td", {class: "r num"}, "text", childNode). Text is always set as text. */
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") Object.assign(el.style, v);          // CSSOM writes are allowed under CSP
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
export const fill = (el, ...kids) => { el.replaceChildren(...kids.flat().filter(Boolean)); return el; };
export const emptyRow = (cols, text) => h("tr", {}, h("td", { colspan: cols, class: "empty" }, text));

export async function getLedger() {
  const r = await fetch("/api/ledger", { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error("ledger " + r.status);
  return r.json();
}

/** Poll the ledger and call render(data). Pauses while the tab is hidden. */
export function live(render, onError, everyMs = 60000) {
  let timer;
  const tick = async () => {
    try { render(await getLedger()); } catch (e) { onError?.(e); }
    clearTimeout(timer);
    if (!document.hidden) timer = setTimeout(tick, everyMs);
  };
  document.addEventListener("visibilitychange", () => { if (!document.hidden) tick(); });
  tick();
}

/** Median when we have every person; otherwise the average (the API caps the list at 1,000). */
export function typicalGift(d) {
  const vals = (d.people || []).map((p) => Number(p.received)).filter((v) => v > 0);
  if (!vals.length) return { label: "Typical contribution (median)", value: 0 };
  // The list is capped at 1,000 people; only fall back to an average when it was actually cut off.
  if ((d.peopleTotal ?? (d.people || []).length) > (d.people || []).length) return { label: "Average per contributor", value: Number(d.totals.received) / Math.max(1, d.totals.contributors) };
  const b = vals.sort((x, y) => x - y), m = b.length >> 1;
  return { label: "Typical contribution (median)", value: b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2 };
}

export function renderTiles(t) {
  const set = (id, v) => { const el = $(id); if (el) el.textContent = fmt(v); };
  set("tCash", t.cash); set("tRec", t.received); set("tOut", t.outstandingPledges); set("tExp", t.expenses);
}

export function renderScale(received, milestonesIn) {
  const ms = (milestonesIn || []).map((m) => ({ amount: Number(m.amount), title: String(m.title || ""), desc: String(m.desc || "") }))
    .filter((m) => m.amount > 0).sort((a, b) => a.amount - b.amount);
  if (!ms.length || !$("ladder")) return;
  const top = ms[ms.length - 1].amount;
  let idx = ms.findIndex((m) => received < m.amount); if (idx === -1) idx = ms.length - 1;
  const cur = ms[idx], prev = idx > 0 ? ms[idx - 1].amount : 0, done = received >= top;
  const pct = done ? 100 : Math.max(0, Math.min(100, ((received - prev) / (cur.amount - prev)) * 100));
  $("stageLabel").textContent = done ? "Full target reached" : `Milestone ${idx + 1} of ${ms.length}: ${cur.title}`;
  $("stageNums").textContent = `${fmt0(received)} of ${fmt0(cur.amount)}`;
  $("stagePct").textContent = done ? "100%" : `${pct.toFixed(pct < 10 ? 1 : 0)}% of this step`;
  const bar = $("stageBar");
  bar.firstElementChild.style.width = pct.toFixed(2) + "%";
  bar.setAttribute("aria-valuenow", pct.toFixed(0));
  bar.setAttribute("aria-valuetext", `${fmt0(received)} raised toward ${cur.title}, ${pct.toFixed(0)} percent`);
  fill($("ladder"), ms.map((m, i) => {
    const isDone = received >= m.amount, isNow = !isDone && i === idx;
    const mini = isNow ? h("div", { class: "mini" }, h("span", { style: { width: pct.toFixed(2) + "%" } })) : null;
    return h("li", { class: isDone ? "done" : isNow ? "now" : "" },
      h("span", { class: "dot", "aria-hidden": "true" }, isDone ? "✓" : String(i + 1)),
      h("div", {}, h("div", { class: "t" }, m.title), h("div", { class: "d" }, m.desc), mini),
      h("div", { class: "a" }, fmt0(m.amount), h("div", { class: "d" }, isDone ? "Reached" : isNow ? "In progress" : "Next")));
  }));
  $("trackFill").style.width = Math.min(100, (received / top) * 100).toFixed(3) + "%";
  fill($("trackTicks"), ms.slice(0, -1).map((m) => h("span", { class: "tick", style: { left: ((m.amount / top) * 100).toFixed(2) + "%" } })));
  $("trackMax").textContent = `${fmt0(top)} full target`;
}

export function renderAreas(areas) {
  const chart = $("nbChart"); if (!chart) return;
  const max = Math.max(1, ...areas.map((a) => a.received + a.outstanding));
  fill(chart, areas.length ? areas.slice(0, 8).map((a) => {
    const frac = (a.received + a.outstanding) / max;
    const bars = h("div", { class: "bars", style: { width: `calc((100% - 76px) * ${frac.toFixed(4)})` } },
      a.received > 0 ? h("span", { class: "seg rec", style: { flex: String(a.received) } }) : null,
      a.outstanding > 0 ? h("span", { class: "seg pl", style: { flex: String(a.outstanding) } }) : null);
    const row = h("div", { class: "hb", tabindex: "0", "aria-label": `${a.area}: ${fmt(a.received)} received, ${fmt(a.outstanding)} pledged not yet received, ${a.contributors} contributors` },
      h("div", { class: "name", title: a.area }, a.area), h("div", { class: "lane" }, bars, h("span", { class: "val" }, fmt0(a.received + a.outstanding))));
    row._data = a;
    return row;
  }) : h("p", { class: "empty" }, "Neighborhood totals appear as pledges come in."));
  fill($("nbTable"), areas.length ? areas.map((a) => h("tr", {}, h("td", {}, a.area), h("td", { class: "r num" }, a.contributors), h("td", { class: "r num" }, fmt(a.received)), h("td", { class: "r num" }, fmt(a.outstanding))))
    : emptyRow(4, "No data yet."));
}

export function wireChartTooltip() {
  const chart = $("nbChart"), tip = $("tip"); if (!chart || !tip) return;
  const show = (row, x, y) => {
    const a = row._data; if (!a) return;
    fill(tip, h("strong", {}, a.area), h("br"), `Received ${fmt(a.received)}`, h("br"), `Pledged, not yet received ${fmt(a.outstanding)}`, h("br"), `${a.contributors} contributor${a.contributors === 1 ? "" : "s"}`);
    tip.hidden = false;
    tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = y + 14 + "px";
  };
  chart.addEventListener("pointermove", (e) => { const r = e.target.closest(".hb"); r ? show(r, e.clientX, e.clientY) : (tip.hidden = true); });
  chart.addEventListener("pointerleave", () => { tip.hidden = true; });
  chart.addEventListener("focusin", (e) => { const r = e.target.closest(".hb"); if (r) { const b = r.getBoundingClientRect(); show(r, b.left + 120, b.bottom - 10); } });
  chart.addEventListener("focusout", () => { tip.hidden = true; });
}

export function renderFooterLegal(org) {
  const el = $("fdacs"); if (!el) return;
  el.textContent = org?.fdacsReg
    ? `Registration ${org.fdacsReg}. A COPY OF THE OFFICIAL REGISTRATION AND FINANCIAL INFORMATION MAY BE OBTAINED FROM THE DIVISION OF CONSUMER SERVICES BY CALLING TOLL-FREE (800-435-7352) WITHIN THE STATE. REGISTRATION DOES NOT IMPLY ENDORSEMENT, APPROVAL, OR RECOMMENDATION BY THE STATE.`
    : "Charitable solicitation registration with the Florida Department of Agriculture and Consumer Services is in progress. Online payments open once registration is complete.";
}
