if (new URLSearchParams(location.search).has("code")) {
  location.replace("/admin/" + location.search);
}

import { $, fill, h, live, renderTiles, renderScale, renderAreas, wireChartTooltip, renderFooterLegal } from "./common.js";
import { goalPrompts } from "./prompts.js";
import { initPledgeForm, renderPledgeState } from "./pledge.js";

function renderPrompts(d) {
  const p = goalPrompts(d);
  const el = $("prompts");
  if (!el) return;
  el.hidden = !p;
  if (!p) return;
  $("promptHead").textContent = p.headline;
  fill($("promptList"), p.lines.map((l) => h("li", {}, l)));
}

function render(d) {
  renderPrompts(d);
  renderPledgeState(d);
  renderTiles(d.totals);
  renderScale(d.totals.received, d.milestones);
  renderAreas(d.areas || []);
  renderFooterLegal(d.org);
  const st = $("status");
  if (st) st.hidden = true;
}

initPledgeForm();
wireChartTooltip();
live(render, () => {
  const s = $("status");
  if (s) {
    s.textContent = "Live figures are temporarily unavailable. Please refresh in a minute.";
    s.hidden = false;
  }
});
