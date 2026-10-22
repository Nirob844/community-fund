// Transactional email through Resend (https://resend.com). Every attempt is logged in
// email_log. With no RESEND_API_KEY set, emails are logged as "skipped" and nothing is sent.
import { db, fmtUSD } from "./util.mjs";

const PLAN_WORD = { weekly: "weekly", monthly: "monthly", quarterly: "every 3 months" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function orgInfo() {
  const { data } = await db().from("settings").select("org_name, fdacs_reg").eq("id", 1).maybeSingle();
  return { name: data?.org_name || "Prospect Road Community Fund", reg: data?.fdacs_reg || "" };
}

function footer(org) {
  const lines = [
    `${org.name} is organized by volunteer residents of Manatee County, Florida.`,
    "Contributions are not tax-deductible unless and until the organization receives 501(c)(3) recognition or uses a fiscal sponsor.",
  ];
  if (org.reg) lines.push(`Registration ${org.reg}. A COPY OF THE OFFICIAL REGISTRATION AND FINANCIAL INFORMATION MAY BE OBTAINED FROM THE DIVISION OF CONSUMER SERVICES BY CALLING TOLL-FREE (800-435-7352) WITHIN THE STATE. REGISTRATION DOES NOT IMPLY ENDORSEMENT, APPROVAL, OR RECOMMENDATION BY THE STATE.`);
  return lines;
}

function render(org, { heading, paragraphs, rows = [], link }) {
  const site = process.env.URL || "";
  const text = [heading, "", ...paragraphs, "", ...rows.map(([k, v]) => `${k}: ${v}`), link ? `\n${link.label}: ${link.href}` : "",
    "", `Every dollar is published at ${site}/transparency/`, "", ...footer(org)].join("\n");
  const html = `<!doctype html><html><body style="margin:0;background:#f2f6fc;font-family:Arial,Helvetica,sans-serif;color:#0f1f38">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:linear-gradient(180deg,#0b2550,#4f8fd6 70%,#f4a65c);padding:22px 24px;color:#ffffff;font-size:13px;letter-spacing:.12em;text-transform:uppercase">${esc(org.name)}</td></tr>
<tr><td style="padding:24px"><h1 style="font-size:22px;margin:0 0 12px">${esc(heading)}</h1>
${paragraphs.map((p) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join("")}
${rows.length ? `<table role="presentation" width="100%" style="border-collapse:collapse;margin:8px 0 16px">${rows.map(([k, v]) => `<tr><td style="padding:6px 0;border-bottom:1px solid #d9e3f0;color:#56657d;font-size:14px">${esc(k)}</td><td style="padding:6px 0;border-bottom:1px solid #d9e3f0;text-align:right;font-family:Menlo,Consolas,monospace;font-size:14px">${esc(v)}</td></tr>`).join("")}</table>` : ""}
${link ? `<p><a href="${esc(link.href)}" style="display:inline-block;background:#1f5fae;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 18px;border-radius:8px">${esc(link.label)}</a></p>` : ""}
<p style="font-size:13px;color:#56657d">Every dollar is published at <a href="${esc(site)}/transparency/" style="color:#1f5fae">${esc(site.replace(/^https?:\/\//, ""))}/transparency</a>.</p>
</td></tr><tr><td style="padding:16px 24px;background:#f2f6fc;font-size:11px;line-height:1.5;color:#56657d">${footer(org).map(esc).join("<br><br>")}</td></tr>
</table></td></tr></table></body></html>`;
  return { text, html };
}

export const templates = {
  pledge: ({ name, amount, shareUrl, online, plan }) => ({
    subject: "Thank you for your pledge",
    heading: `Thank you, ${name}`,
    paragraphs: [
      plan ? `Your giving plan of ${fmtUSD(plan.installment)} ${PLAN_WORD[plan.frequency] || plan.frequency}, ${plan.payments} payments (${fmtUSD(amount)} in all), is recorded.`
        : `Your pledge of ${fmtUSD(amount)} to the community fund is recorded.`,
      plan ? "Once you finish setting it up on the secure payment page, each payment is taken automatically and you get a receipt every time. You can stop it at any time from your private link."
        : online ? "If you haven't paid yet, you can complete your pledge from the fund's website. You can also give again or set up smaller payments over time from your private link." : "The treasurer will let you know how to pay. Checks, Zelle and cash are welcome.",
      "Your private link below shows your contribution and your share of the fund at any time. Please don't share it.",
    ],
    link: shareUrl ? { label: "See my contribution", href: shareUrl } : null,
  }),
  receipt: ({ name, amount, date, method, number }) => ({
    subject: `Receipt for your ${fmtUSD(amount)} contribution`,
    heading: "Contribution receipt",
    paragraphs: [`Thank you, ${name}. We have received your contribution.`],
    rows: [["Amount", fmtUSD(amount)], ["Date received", date], ["Method", method], ["Receipt number", number]],
  }),
  refund: ({ name, amount, date, method, reason }) => ({
    subject: `Refund of ${fmtUSD(amount)}`,
    heading: "Refund issued",
    paragraphs: [`${name}, we have refunded ${fmtUSD(amount)} to you.${reason ? ` Reason: ${reason}.` : ""}`, method === "Stripe" ? "Card refunds usually appear within 5 to 10 business days." : ""].filter(Boolean),
    rows: [["Amount", fmtUSD(amount)], ["Date", date], ["Method", method]],
  }),
  payout: ({ name, amount, date, method }) => ({
    subject: `Your share of the closing fund: ${fmtUSD(amount)}`,
    heading: "The fund has closed",
    paragraphs: [`${name}, the community fund has closed. As promised, the remaining balance is being returned in proportion to what each neighbor gave.`, `Your share is ${fmtUSD(amount)}.`],
    rows: [["Amount", fmtUSD(amount)], ["Date", date], ["Method", method]],
  }),
  alert: ({ title, lines }) => ({ subject: `[Fund alert] ${title}`, heading: title, paragraphs: lines }),
  plan_started: ({ name, installment, frequency, payments }) => ({
    subject: "Your giving plan is set up",
    heading: `Thank you, ${name}`,
    paragraphs: [`Your giving plan is active: ${fmtUSD(installment)} ${frequency}, ${payments} payments in all.`,
      "Each payment is taken automatically and you'll get a receipt every time. It stops by itself after the last payment, and you can stop it sooner from your private link."],
    rows: [["Each payment", fmtUSD(installment)], ["How often", frequency], ["Payments", String(payments)], ["Total", fmtUSD(installment * payments)]],
  }),
  plan_stopped: ({ name, installment, paidCount, payments }) => ({
    subject: "Your giving plan has stopped",
    heading: "Giving plan stopped",
    paragraphs: [`${name}, your giving plan of ${fmtUSD(installment)} per payment has stopped. No further payments will be taken.`,
      `${paidCount} of ${payments} payments were made. Thank you for every one of them.`],
  }),
  plan_failed: ({ name, installment }) => ({
    subject: "A giving plan payment didn't go through",
    heading: "Payment didn't go through",
    paragraphs: [`${name}, your card was declined for this ${fmtUSD(installment)} giving plan payment. Stripe will try again over the next few days.`,
      "If your card has changed, you can stop this plan from your private link and start a new one. Nothing else is needed if you'd like it to retry."],
  }),
};

/** Send one email. Never throws; returns {status}. */
export async function sendEmail({ to, kind, contributorId = null, data }) {
  const s = db();
  const log = (status, extra = {}) => s.from("email_log").insert({ contributor_id: contributorId, kind, to_email: to || "", status, ...extra });
  if (!to) { await log("no-address"); return { status: "no-address" }; }
  const org = await orgInfo();
  const t = templates[kind](data);
  const { text, html } = render(org, t);
  const key = process.env.RESEND_API_KEY;
  if (!key) { await log("skipped"); return { status: "skipped" }; }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || `${org.name} <fund@example.org>`, to: [to], subject: t.subject, text, html,
        reply_to: process.env.EMAIL_REPLY_TO || undefined }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { await log("failed", { error: String(d.message || r.status).slice(0, 200) }); return { status: "failed" }; }
    await log("sent", { provider_id: d.id || null });
    return { status: "sent" };
  } catch (e) {
    await log("failed", { error: String(e.message).slice(0, 200) });
    return { status: "failed" };
  }
}

export const receiptNumber = (id) => "R-" + String(id).replace(/-/g, "").slice(0, 10).toUpperCase();
