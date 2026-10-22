import { $, h, fill, fmt, fmt0, emptyRow, live, renderAreas, wireChartTooltip, renderFooterLegal, typicalGift } from "./common.js";

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
};
const compact = (n) => n >= 1e6 ? "$" + (n / 1e6).toFixed(n % 1e6 ? 1 : 0) + "M" : n >= 1000 ? "$" + (n / 1000).toFixed(n % 1000 ? 1 : 0) + "K" : "$" + Math.round(n);
const niceMax = (v) => { if (v <= 0) return 100; const p = 10 ** Math.floor(Math.log10(v)); return [1, 2, 2.5, 5, 10].map((m) => m * p).find((x) => x >= v); };
const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y), m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const tip = () => $("tip");
function showTip(nodes, x, y) { const t = tip(); fill(t, nodes); t.hidden = false; t.style.left = Math.min(x + 14, innerWidth - t.offsetWidth - 8) + "px"; t.style.top = y + 14 + "px"; }
const hideTip = () => { tip().hidden = true; };

/** Simple horizontal bar list (one series). */
function bars(el, rows, emptyText) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  fill(el, rows.length ? rows.map((r) => h("div", { class: "hb", tabindex: "0", "aria-label": `${r.label}: ${fmt(r.value)}${r.note ? ", " + r.note : ""}` },
    h("div", { class: "name", title: r.label }, r.label),
    h("div", { class: "lane" }, h("div", { class: "bars", style: { width: `calc((100% - 96px) * ${(r.value / max).toFixed(4)})` } }, h("span", { class: "seg rec", style: { flex: "1" } })),
      h("span", { class: "val" }, compact(r.value) + (r.pct != null ? ` · ${r.pct}%` : "")))))
    : h("p", { class: "empty" }, emptyText));
}

/** Cumulative line with area wash and a milestone reference line. */
function timeChart(el, daily, milestone) {
  const byDay = new Map();
  (daily || []).forEach((r) => byDay.set(r.date, (byDay.get(r.date) || 0) + Number(r.amount)));
  const days = [...byDay.keys()].sort();
  if (!days.length) return fill(el, h("p", { class: "empty" }, "The running total appears once money is received."));
  let run = 0; const pts = days.map((d) => ({ d, v: (run += byDay.get(d)) }));
  if (pts.length === 1) pts.unshift({ d: pts[0].d, v: 0 });
  const W = 560, H = 240, L = 52, R = 14, T = 16, B = 30;
  const t0 = Date.parse(pts[0].d), t1 = Math.max(Date.parse(pts.at(-1).d), t0 + 86400000);
  const target = milestone && milestone.amount <= Math.max(run * 4, 1) ? milestone : null;
  const yMax = niceMax(Math.max(run, target ? target.amount : 0) * 1.05);
  const x = (d) => L + ((Date.parse(d) - t0) / (t1 - t0)) * (W - L - R);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(pts.at(-1).d).toFixed(1)} ${y(0)} L${x(pts[0].d).toFixed(1)} ${y(0)} Z`;
  const fmtD = (d) => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "svgchart", role: "img", "aria-label": `Running total rises to ${fmt0(run)} by ${fmtD(pts.at(-1).d)}` },
    ticks.map((v) => s("g", {}, s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: L - 8, y: y(v) + 4, "text-anchor": "end", class: "axis" }, compact(v)))),
    target ? s("g", {}, s("line", { x1: L, x2: W - R, y1: y(target.amount), y2: y(target.amount), class: "goal" }), s("text", { x: W - R, y: y(target.amount) - 6, "text-anchor": "end", class: "axis" }, `Goal: ${target.title} ${compact(target.amount)}`)) : null,
    s("path", { d: area, class: "wash" }), s("path", { d: line, class: "line" }),
    s("circle", { cx: x(pts.at(-1).d), cy: y(run), r: 5, class: "dot" }),
    s("text", { x: Math.min(x(pts.at(-1).d), W - R - 4), y: y(run) - 10, "text-anchor": "end", class: "lab" }, compact(run)),
    s("text", { x: L, y: H - 8, class: "axis" }, fmtD(pts[0].d)), s("text", { x: W - R, y: H - 8, "text-anchor": "end", class: "axis" }, fmtD(pts.at(-1).d)),
    s("rect", { x: L, y: T, width: W - L - R, height: H - T - B, class: "hit" }));
  const hit = svg.lastChild;
  hit.addEventListener("pointermove", (e) => {
    const box = svg.getBoundingClientRect(), px = ((e.clientX - box.left) / box.width) * W;
    let best = pts[0]; for (const p of pts) if (Math.abs(x(p.d) - px) < Math.abs(x(best.d) - px)) best = p;
    showTip([h("strong", {}, fmtD(best.d)), h("br"), `Running total ${fmt(best.v)}`, byDay.get(best.d) ? [h("br"), `Received that day ${fmt(byDay.get(best.d))}`] : null], e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", hideTip);
  fill(el, svg);
}

/** Columns: number of contributors per gift-size bucket. */
function sizeChart(el, sizes) {
  const buckets = [["Under $50", 0, 50], ["$50–99", 50, 100], ["$100–249", 100, 250], ["$250–499", 250, 500], ["$500–999", 500, 1000], ["$1,000+", 1000, Infinity]];
  const counts = buckets.map(([l], i) => ({ l, n: Number((sizes || [])[i] || 0) }));
  if (!counts.some((c) => c.n)) return fill(el, h("p", { class: "empty" }, "Contribution sizes appear once money is received."));
  const W = 440, H = 220, L = 30, R = 6, T = 22, B = 34, max = Math.max(1, ...counts.map((c) => c.n));
  const yMax = Math.max(2, Math.ceil(max * 1.15)), bw = (W - L - R) / counts.length, colW = Math.min(24, bw * 0.6);
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, class: "svgchart", role: "img", "aria-label": counts.map((c) => `${c.l}: ${c.n}`).join(", ") },
    [0, Math.round(yMax / 2), yMax].map((v) => s("g", {}, s("line", { x1: L, x2: W - R, y1: y(v), y2: y(v), class: "grid" }), s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end", class: "axis" }, v))),
    counts.map((c, i) => {
      const cx = L + bw * i + bw / 2, top = y(c.n), base = y(0), hgt = Math.max(0, base - top);
      const r = Math.min(4, hgt);
      const path = hgt > 0 ? `M${cx - colW / 2} ${base} V${top + r} Q${cx - colW / 2} ${top} ${cx - colW / 2 + r} ${top} H${cx + colW / 2 - r} Q${cx + colW / 2} ${top} ${cx + colW / 2} ${top + r} V${base} Z` : "";
      const g = s("g", { class: "col" }, path ? s("path", { d: path, class: "bar" }) : null,
        c.n ? s("text", { x: cx, y: top - 6, "text-anchor": "middle", class: "lab" }, c.n) : null,
        s("text", { x: cx, y: H - 12, "text-anchor": "middle", class: "axis" }, c.l),
        s("rect", { x: cx - bw / 2, y: T, width: bw, height: H - T - B, class: "hit" }));
      g.lastChild.addEventListener("pointermove", (e) => showTip([h("strong", {}, c.l), h("br"), `${c.n} neighbor${c.n === 1 ? "" : "s"}`], e.clientX, e.clientY));
      g.lastChild.addEventListener("pointerleave", hideTip);
      return g;
    }));
  fill(el, svg);
}

function render(d) {
  const t = d.totals;
  renderFooterLegal(d.org);
  $("updated").textContent = "Updated " + new Date(d.generatedAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const areas = (d.areas || []).filter((a) => a.area !== "Not given");
  const received = Number(t.received);
  $("kRec").textContent = fmt(received);
  $("kPeople").textContent = Number(t.contributors).toLocaleString();
  $("kAreas").textContent = String(areas.length);
  const tg = typicalGift(d);
  $("kMedianLabel").textContent = tg.label; $("kMedian").textContent = fmt(tg.value);

  renderAreas((d.areas || []).map((a) => ({ ...a, received: Number(a.received), outstanding: Number(a.outstanding), contributors: Number(a.contributors) })));
  const top = (d.areas || [])[0];
  $("topArea").textContent = top && received > 0 ? `${top.area} leads with ${Math.round((Number(top.received) / received) * 100)}% of money received.` : "";

  const ms = (d.milestones || []).slice().sort((a, b) => a.amount - b.amount);
  timeChart($("timeChart"), d.daily, ms.find((m) => received < m.amount) || ms.at(-1));
  sizeChart($("sizeChart"), d.sizes);

  const gross = Number(t.receivedGross ?? received);
  bars($("methodChart"), (d.methods || []).map((m) => ({ label: m.method, value: Number(m.amount), pct: gross ? Math.round((Number(m.amount) / gross) * 100) : 0 })), "Shown once money is received.");
  const exp = Number(t.expenses);
  bars($("spendChart"), (d.categories || []).map((c) => ({ label: c.category, value: Number(c.amount), pct: exp ? Math.round((Number(c.amount) / exp) * 100) : 0 })), "No money has been spent yet.");
  const cat = Object.fromEntries((d.categories || []).map((c) => [c.category, Number(c.amount)]));
  const legal = (cat["Legal fees"] || 0) + (cat["Expert reports"] || 0) + (cat["Filing and court fees"] || 0);
  $("spendNote").textContent = !exp ? "Spending by category." :
    (legal > 0 ? `${Math.round((legal / exp) * 100)}% of spending has gone directly to the legal case. ` : "No legal fees paid yet. ") + `${fmt(exp)} spent of ${fmt(received)} received.`;

  const months = d.months || [];
  fill($("monthRows"), months.length ? months.map((x) => h("tr", {}, h("td", {}, new Date(x.month + "-15T12:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" })),
      h("td", { class: "r num" }, x.n), h("td", { class: "r num" }, fmt(Number(x.received) - Number(x.refunded || 0))), h("td", { class: "r num" }, fmt(Number(x.spent))),
      h("td", { class: "r num" }, fmt(Number(x.received) - Number(x.refunded || 0) - Number(x.spent)))))
    : emptyRow(5, "No activity yet."));
  $("status").hidden = true;
}

wireChartTooltip();
live(render, () => { const el = $("status"); el.textContent = "Live figures are temporarily unavailable. Please refresh in a minute."; el.hidden = false; });
