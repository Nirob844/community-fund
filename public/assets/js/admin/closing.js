// Fund Closing & Payouts domain module
import { $, fill, fmt, h, emptyRow } from "../common.js";
import { state, note, showToast, setBtnLoading, can, btn, confirmAct, friendly, today, csvDownload, loadTop, emailAbout } from "./context.js";

let plan = [];

const setStatus = async (fund_status, extra = {}) => {
  const { error } = await state.sb.from("settings").update({
    fund_status,
    closing_note: $("clNote")?.value.trim() || "",
    updated_at: new Date().toISOString(),
    ...extra
  }).eq("id", 1);
  if (error) {
    note($("status"), friendly(error), "err");
    showToast(friendly(error), "err");
  } else {
    $("status").hidden = true;
    showToast(`Fund status updated to ${fund_status}`, "ok");
  }
  state.loaders.closing?.();
};

export function initClosing() {
  state.loaders.closing = async () => {
    const [t, { data, error }] = await Promise.all([loadTop(), state.sb.rpc("closing_plan")]);
    if (error) return note($("status"), friendly(error), "err");
    plan = data || [];
    const st = state.settings?.fund_status || "open";
    const pillCls = st === "open" ? "pill ok" : (st === "closing" ? "pill pend" : "pill due");
    const stText = { open: "Open", closing: "Closing", closed: "Closed" }[st] || st;
    fill($("clStatus"), h("span", { class: pillCls }, stText));
    if ($("clPool")) $("clPool").textContent = fmt(Number(t?.closingPool || 0));
    if ($("clPaid")) $("clPaid").textContent = fmt(Number(t?.payouts || 0));
    if ($("clNote")) $("clNote").value = state.settings?.closing_note || "";
    if ($("clStart")) $("clStart").hidden = st !== "open";
    if ($("clFinish")) $("clFinish").hidden = st !== "closing";
    if ($("clReopen")) $("clReopen").hidden = st === "open";
    const unpaid = Number(t?.expensesUnpaid || 0);
    note($("clMsg"), unpaid > 0 ? `There are ${fmt(unpaid)} of unpaid bills. Pay them before making payouts so the plan doesn't change.` : "", "warn");
    const remaining = plan.reduce((a, r) => a + Number(r.remaining), 0);
    if ($("planNote")) $("planNote").textContent = plan.length ? `${plan.length} contributors · ${fmt(plan.reduce((a, r) => a + Number(r.due), 0))} due in total · ${fmt(remaining)} still to pay. Anonymous gifts with no contact details can't be returned and stay with the fund.` : "";
    fill($("planRows"), plan.length ? plan.map((r) => {
      const cell = h("td", { class: "r" });
      if (can("treasurer") && st !== "open" && Number(r.remaining) > 0 && r.contributor_id) {
        const m = h("select", { "aria-label": "Payout method" }, ["Check", "Zelle", "Bank transfer", "Cash", "Other"].map((x) => h("option", {}, x)));
        cell.append(h("div", { class: "edit-inline" }, m, btn("Record payout", async (e) => {
          e.currentTarget.disabled = true;
          const { data: row, error: err } = await state.sb.from("refunds").insert({
            contributor_id: r.contributor_id,
            public_label: r.label,
            area: r.area,
            amount: Number(r.remaining),
            kind: "closing_payout",
            method: m.value,
            reason: "Final distribution"
          }).select("id").single();
          if (err) return note($("status"), friendly(err), "err");
          await emailAbout("payout", row.id);
          state.loaders.closing?.();
        }, "btn small")));
      }
      return h("tr", {},
        h("td", {}, r.full_name || r.label, h("div", { class: "hint" }, r.area)),
        h("td", {}, r.email || "—"),
        h("td", { class: "r num" }, fmt(Number(r.contributed))),
        h("td", { class: "r num" }, (Number(r.share) * 100).toFixed(2) + "%"),
        h("td", { class: "r num" }, fmt(Number(r.due))),
        h("td", { class: "r num" }, fmt(Number(r.paid_out))),
        h("td", { class: "r num" }, fmt(Number(r.remaining))),
        cell
      );
    }) : emptyRow(8, "Nobody has contributed yet."));
  };

  $("clStart")?.addEventListener("click", (e) => confirmAct(e.currentTarget, "Stop accepting new pledges?", () => setStatus("closing"), () => {}));
  $("clFinish")?.addEventListener("click", (e) => confirmAct(e.currentTarget, "Mark the fund closed?", () => setStatus("closed", { closed_on: today(), accept_online: false }), () => {}));
  $("clReopen")?.addEventListener("click", (e) => confirmAct(e.currentTarget, "Reopen the fund?", () => setStatus("open", { closed_on: null }), () => {}));
  $("clCsv")?.addEventListener("click", () => csvDownload(`payout-plan-${today()}.csv`, [
    ["contributor", "email", "area", "contributed", "share_percent", "due", "paid_out", "remaining"],
    ...plan.map((r) => [r.full_name || r.label, r.email || "", r.area, Number(r.contributed), Number((Number(r.share) * 100).toFixed(4)), Number(r.due), Number(r.paid_out), Number(r.remaining)])
  ]));
  $("clNoteSave")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    setBtnLoading(btn, "Saving…");
    try {
      const { error } = await state.sb.from("settings").update({ closing_note: $("clNote").value.trim(), updated_at: new Date().toISOString() }).eq("id", 1);
      if (error) throw error;
      showToast("Closing note saved", "ok");
    } catch (err) {
      showToast(friendly(err), "err");
    } finally {
      setBtnLoading(btn, false);
    }
  });
}
