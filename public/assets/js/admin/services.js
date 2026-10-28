// Reusable data mutation services for pledges, deposits, expenses, and refunds
import { fmt } from "../common.js";
import { state, friendly, FREQ, newContributor, emailAbout, emailWord, publicLabel } from "./context.js";

/**
 * Reusable pledge recording logic used by both Quick Record (#plForm) and Pledges tab (#plInForm)
 */
export async function savePledge({ cid, full, email, address, area, label, plan, amount, date }) {
  if (state.settings?.fund_status === "closing" || state.settings?.fund_status === "closed") {
    throw new Error("The fund is closing, so new pledges can't be added. Reopen it in the Closing tab first.");
  }
  if (!cid) {
    if (!full || !area) throw new Error("Search for the person, or enter a new person's name and neighborhood.");
    cid = (await newContributor({ full, email, address, area, label })).id;
  }
  if (plan && !(plan.installment > 0 && Number.isInteger(plan.payments) && plan.payments >= 2 && plan.payments <= 120)) {
    throw new Error("Enter each payment and between 2 and 120 payments.");
  }

  const { data: pl, error } = await state.sb.from("pledges").insert({
    contributor_id: cid,
    amount,
    pledged_on: date,
    source: "staff",
    note: plan ? `Giving plan: ${fmt(plan.installment)} ${FREQ[plan.frequency].toLowerCase()} x ${plan.payments}` : ""
  }).select("id").single();

  if (error) throw new Error(friendly(error));

  if (plan) {
    const { error: e2 } = await state.sb.from("giving_plans").insert({
      contributor_id: cid,
      pledge_id: pl.id,
      ...plan,
      method: "manual",
      start_on: date
    });
    if (e2) throw new Error(friendly(e2));
  }

  return { cid, pledgeId: pl.id, plan };
}

/**
 * Reusable deposit recording logic used by both Quick Record (#rForm) and Pledges tab (#rInForm)
 */
export async function saveDeposit({ cid, full, email, area, label, amount, date, method, reference, depositRef, plan, emailReceipt }) {
  if (!cid) {
    label = label || "Anonymous neighbor";
    if (full) {
      cid = (await newContributor({ full, email, area, label })).id;
    }
  }

  const { data, error } = await state.sb.from("receipts").insert({
    contributor_id: cid,
    public_label: label,
    area,
    amount,
    received_on: date,
    method,
    reference: reference || "",
    deposit_ref: depositRef || "",
    ...(plan ? { plan_id: plan.id, pledge_id: plan.pledge_id } : {})
  }).select("id").single();

  if (error) throw new Error(friendly(error));

  let extra = "";
  if (emailReceipt && cid) {
    extra = " " + emailWord(await emailAbout("receipt", data.id));
  }

  return { receiptId: data.id, label, extra };
}

/**
 * Reusable expense recording logic used by Quick Record (#eForm)
 */
export async function saveExpense({ date, amount, payee, category, status, description }) {
  const { data, error } = await state.sb.from("expenses").insert({
    spent_on: date,
    amount,
    payee,
    category,
    status,
    paid_on: status === "paid" ? date : null,
    description: description || ""
  }).select("id").single();

  if (error) throw new Error(friendly(error));
  return data;
}
