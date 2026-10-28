// Fund Settings domain module
import { $, fill, h, emptyRow } from "../common.js";
import { state, note, setBtnLoading, btn, friendly, loadTop } from "./context.js";

async function loadAreas() {
  const { data, error } = await state.sb.rpc("area_counts");
  if (error) return note($("aMsg"), friendly(error), "err");
  fill($("areaRows"), (data || []).length ? data.map((a) => {
    const inp = h("input", { list: "areasA", maxlength: "60", value: a.area, "aria-label": `New name for ${a.area}` });
    return h("tr", {},
      h("td", {}, a.area),
      h("td", { class: "r num" }, Number(a.contributors)),
      h("td", { class: "r num" }, Number(a.receipts)),
      h("td", {}, h("div", { class: "edit-inline" }, inp, btn("Apply", async () => {
        if (!inp.value.trim() || inp.value.trim() === a.area) return;
        const { data: n, error: err } = await state.sb.rpc("rename_area", { old_name: a.area, new_name: inp.value.trim() });
        if (err) return note($("aMsg"), friendly(err), "err");
        note($("aMsg"), `Renamed "${a.area}" on ${n} entries. Future entries using that name will follow.`);
        loadAreas();
        loadTop();
      }, "btn small")))
    );
  }) : emptyRow(4, "No neighborhoods recorded yet."));
}

function goalRow(m = { amount: "", title: "", desc: "" }) {
  const n = $("goalRows").children.length + 1;
  return h("tr", {},
    h("td", {}, h("input", { type: "number", min: "1", step: "1", value: m.amount, "aria-label": `Goal ${n} amount`, class: "g-amt" })),
    h("td", {}, h("input", { maxlength: "80", value: m.title, "aria-label": `Goal ${n} title`, class: "g-title" })),
    h("td", {}, h("input", { maxlength: "200", value: m.desc || "", "aria-label": `Goal ${n} description`, class: "g-desc" })),
    h("td", { class: "r" }, btn("Remove", (e) => { e.currentTarget.closest("tr").remove(); $("sForm").dataset.touched = "1"; }))
  );
}

export function initSettings() {
  $("goalAdd")?.addEventListener("click", () => {
    $("goalRows").append(goalRow());
    $("sForm").dataset.touched = "1";
  });

  state.loaders.settings = async () => {
    loadAreas();
    await loadTop();
    if (!state.settings || $("sForm").dataset.touched) return;
    $("sOrg").value = state.settings.org_name;
    $("sReg").value = state.settings.fdacs_reg;
    $("sGfm").value = state.settings.gofundme_url;
    $("sOnline").checked = state.settings.accept_online;
    fill($("goalRows"), []);
    (state.settings.milestones || []).forEach((m) => $("goalRows").append(goalRow(m)));
    $("sMin").value = Number(state.settings.min_gift ?? 5);
    $("sMax").value = Number(state.settings.max_gift ?? 10000);
    $("sMaxPledge").value = Number(state.settings.max_pledge ?? 2000000);
    $("sMaxDep").value = Number(state.settings.max_deposit ?? 250000);
    $("sPlans").checked = state.settings.allow_plans !== false;
    $("sPlanMax").value = state.settings.max_plan_payments ?? 24;
    $("sAmounts").value = (state.settings.suggested_amounts || [25, 50, 100, 250, 500, 1000]).join(", ");
    $("sPrompts").checked = state.settings.prompts_enabled !== false;
    $("sHeadline").value = state.settings.prompt_headline || "";
    $("sDeadline").value = state.settings.goal_deadline || "";
  };

  $("sForm")?.addEventListener("input", () => { $("sForm").dataset.touched = "1"; });
  $("sForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btnEl = ev.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btnEl, "Saving settings...");
    const msg = $("sMsg"), gfm = $("sGfm").value.trim();
    if (gfm && !/^https:\/\//i.test(gfm)) { done(false); return note(msg, "The GoFundMe link must start with https://", "err"); }
    const ms = [...$("goalRows").children].map((tr) => ({
      amount: Number(String(tr.querySelector(".g-amt").value).replace(/[$,]/g, "")),
      title: tr.querySelector(".g-title").value.trim(),
      desc: tr.querySelector(".g-desc").value.trim()
    })).filter((m) => m.amount || m.title);
    if (!ms.length || ms.some((m) => !(m.amount > 0) || !m.title)) { done(false); return note(msg, "Each goal needs an amount and a title.", "err"); }
    if (ms.length > 10) { done(false); return note(msg, "Up to 10 goals.", "err"); }
    const lim = {
      min_gift: Number($("sMin").value),
      max_gift: Number($("sMax").value),
      max_pledge: Number($("sMaxPledge").value),
      max_deposit: Number($("sMaxDep").value),
      max_plan_payments: Number($("sPlanMax").value)
    };
    if (!(lim.min_gift >= 1 && lim.min_gift <= lim.max_gift && lim.max_gift <= 2000000 && lim.max_pledge >= lim.min_gift && lim.max_pledge <= 2000000 && lim.max_deposit >= 1 && lim.max_deposit <= 2000000)) {
      done(false); return note(msg, "Check the limits: the smallest gift must be below the largest, and nothing above $2,000,000.", "err");
    }
    if (!(Number.isInteger(lim.max_plan_payments) && lim.max_plan_payments >= 2 && lim.max_plan_payments <= 120)) {
      done(false); return note(msg, "A plan can have 2 to 120 payments.", "err");
    }
    const amounts = $("sAmounts").value.split(/[,\s]+/).map((x) => Number(x.replace(/[$]/g, ""))).filter((x) => x > 0);
    if (!amounts.length || amounts.length > 8 || amounts.some((a) => a > 2000000)) {
      done(false); return note(msg, "Enter 1 to 8 suggested amounts.", "err");
    }
    const reg = $("sReg").value.trim().toUpperCase();
    if (reg && !/^[A-Z]{1,3}[0-9]{2,8}$/.test(reg)) {
      done(false); return note(msg, "The registration number should look like CH12345.", "err");
    }
    if ($("sOnline").checked && !reg) {
      done(false); return note(msg, "Enter the FDACS registration number before opening online payments.", "err");
    }
    const { error } = await state.sb.from("settings").update({
      org_name: $("sOrg").value.trim(),
      fdacs_reg: reg,
      gofundme_url: gfm,
      accept_online: $("sOnline").checked,
      milestones: ms.sort((a, b) => a.amount - b.amount),
      ...lim,
      allow_plans: $("sPlans").checked,
      suggested_amounts: [...new Set(amounts)].sort((a, b) => a - b),
      prompts_enabled: $("sPrompts").checked,
      prompt_headline: $("sHeadline").value.trim(),
      goal_deadline: $("sDeadline").value || null,
      updated_at: new Date().toISOString()
    }).eq("id", 1);
    if (error) { done(false); return note(msg, friendly(error), "err"); }
    done(true);
    delete $("sForm").dataset.touched;
    note(msg, "Settings saved. The public site updates within a minute.");
    loadTop();
  });
}
