// Contributors & Community domain module
import { $, fill, h, emptyRow } from "../common.js";
import { state, note, setBtnLoading, makePicker, safeQ, can, btn, confirmAct, pager, friendly, EMAIL, PAGE } from "./context.js";

let ppPage = 0;
let editing = null;
let mergeFrom = null;
let mPick = null;

function openEdit(c) {
  editing = c;
  if ($("mForm")) $("mForm").hidden = true;
  $("cName").value = c.full_name;
  $("cEmail").value = c.email || "";
  $("cAddr").value = c.address || "";
  $("cArea").value = c.area || "";
  $("cLabel").value = c.public_label || "";
  $("cMsg").hidden = true;
  $("cForm").hidden = false;
  $("cName").focus();
}

function openMerge(c) {
  mergeFrom = c;
  if ($("cForm")) $("cForm").hidden = true;
  mPick?.set(null);
  $("mTitle").textContent = `Combine "${c.full_name}" into another record`;
  $("mMsg").hidden = true;
  $("mForm").hidden = false;
  $("mFind")?.focus();
}

export function initPeople() {
  mPick = makePicker("m", { allowNew: false });

  state.loaders.people = async (page = ppPage) => {
    ppPage = Math.max(0, page);
    let q = state.sb.from("contributors").select("*", { count: "exact" });
    const s = safeQ($("ppSearch")?.value);
    if (s) q = q.or(`full_name.ilike.%${s}%,email.ilike.%${s}%,area.ilike.%${s}%,public_label.ilike.%${s}%`);
    const { data, count, error } = await q.order("full_name").range(ppPage * PAGE, ppPage * PAGE + PAGE - 1);
    if (error) return note($("status"), friendly(error), "err");
    fill($("peopleRows"), data.length ? data.map((c) => h("tr", {},
      h("td", {}, c.full_name),
      h("td", {}, c.email || "—"),
      h("td", {}, c.address || "—"),
      h("td", {}, c.area || "—"),
      h("td", {}, c.public_label || "—"),
      h("td", { class: "r" }, can("treasurer") && c.full_name !== "[erased]" ? [
        btn("Edit", () => openEdit(c)),
        btn("Combine", () => openMerge(c)),
        btn("Erase", (e) => confirmAct(e.currentTarget, "Erase this person's details for good?", () => state.sb.rpc("anonymize_contributor", { cid: c.id })))
      ] : null)
    )) : emptyRow(6, "No contributors match."));
    pager($("peoplePager"), ppPage, count || 0, (p) => state.loaders.people(p));
  };

  let ppT;
  $("ppSearch")?.addEventListener("input", () => {
    clearTimeout(ppT);
    ppT = setTimeout(() => state.loaders.people(0), 300);
  });

  $("cCancel")?.addEventListener("click", () => { $("cForm").hidden = true; });
  $("cForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Updating...");
    const email = $("cEmail").value.trim().toLowerCase();
    if (!$("cName").value.trim() || !$("cLabel").value.trim()) { done(false); return note($("cMsg"), "Name and public label are required.", "err"); }
    if (email && !EMAIL.test(email)) { done(false); return note($("cMsg"), "Enter a valid email, or leave it blank.", "err"); }
    const { error } = await state.sb.from("contributors").update({
      full_name: $("cName").value.trim(),
      email,
      address: $("cAddr").value.trim(),
      area: $("cArea").value.trim(),
      public_label: $("cLabel").value.trim()
    }).eq("id", editing.id);
    if (error) { done(false); return note($("cMsg"), friendly(error), "err"); }
    done(true);
    $("cForm").hidden = true;
    note($("status"), "Contributor updated. Public ledger lines now use the new label.", "");
    state.loaders.people?.();
  });

  $("mCancel")?.addEventListener("click", () => { $("mForm").hidden = true; });
  $("mForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Combining...");
    const dst = mPick.get();
    if (!dst || dst.id === mergeFrom.id) { done(false); return note($("mMsg"), "Choose a different person to keep.", "err"); }
    const { error } = await state.sb.rpc("merge_contributors", { src: mergeFrom.id, dst: dst.id });
    if (error) { done(false); return note($("mMsg"), friendly(error), "err"); }
    done(true);
    $("mForm").hidden = true;
    note($("status"), `Combined into ${dst.full_name}. All pledges and money moved.`, "");
    state.loaders.people?.();
  });
}
