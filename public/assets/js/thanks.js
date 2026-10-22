import { $, h, fill } from "./common.js";
let url = null;
try { url = localStorage.getItem("fundShareUrl"); } catch {}
if (new URLSearchParams(location.search).get("plan") === "1") {
  $("thanksLede").textContent = "Your giving plan is set up. The first payment went through, and the rest will follow automatically.";
  $("thanksNote").textContent = "You'll get a receipt by email after every payment. The plan stops by itself after the last one, and you can stop it sooner from your private link.";
}
if (url && /^https?:\/\//.test(url)) fill($("shareLink"), "Your private link to track your contribution, give again or manage a giving plan: ", h("a", { href: url }, "open my page"), ". Bookmark it.");
