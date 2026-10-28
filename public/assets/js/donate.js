import { $, live, renderTiles, renderFooterLegal } from "./common.js";
import { initPledgeForm, renderPledgeState } from "./pledge.js";

function render(d) {
  renderPledgeState(d);
  if (d.totals) renderTiles(d.totals);
  if (d.org) renderFooterLegal(d.org);
  const st = $("status");
  if (st) st.hidden = true;
}

initPledgeForm();
live(render, () => {
  const s = $("status");
  if (s) {
    s.textContent = "Live figures are temporarily unavailable. Please refresh in a minute.";
    s.hidden = false;
  }
});
