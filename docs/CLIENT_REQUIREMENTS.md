# Client Requirements & Project Scope

**Project:** Prospect Road Community Fund Website  
**Document Version:** 1.0  
**Created:** October 2026  
**Related Documents:** [docs/ROADMAP.md](file:///c:/Users/Nirob/project/community-fund-website/docs/ROADMAP.md) · [docs/LAUNCH_CHECKLIST.md](file:///c:/Users/Nirob/project/community-fund-website/docs/LAUNCH_CHECKLIST.md) · [docs/HANDOVER.md](file:///c:/Users/Nirob/project/community-fund-website/docs/HANDOVER.md)

---

## ১. মূল দায়িত্বসমূহ (Client's Task Overview)

নিচে ক্লায়েন্ট প্রদত্ত মূল রিকোয়ারমেন্ট এবং কাজের ধাপগুলো সংরক্ষিত করা হলো:

```
Third-party Accounts Setup-e Shahajjo Kora:
Fund-er name-e third-party account gulo create korte hobe: Supabase (database), Stripe (payments), Resend (emails), Cloudflare Turnstile (bot protection), Netlify (hosting), ebong Domain। Client egulo fund-er email-e owner hishebe khulbe, ar apnake team member hishebe access dibe; apnake ei setup-e tader guide korte hobe।

Service Integration & Linking:
Website codebase-er sathe Supabase, Stripe, Resend email, Cloudflare Turnstile ebong Netlify hosting properly integrate korte hobe। Custom domain, DNS ebong email sender verification configure korte hobe।

Fixes Review & Hardening:
Client bolche fix gulo kora ache, tobe apnake setup-er shomoy quick review kore nite hobe। Neighborhood grouping thikmoto hocche kina check kora। Server-side registration rule enforce kora। Audit log jate keu modify ba change na korte pare, tar protection confirm kora।

Deployment & Security Check:
Site-ta Netlify ebong custom domain-e deploy korte hobe। Post-deploy security check run kore ensure korte hobe jate 0 failure ashe।

18-Step Test-Mode Run:
Real service gulo connect kore test mode-e pura 18-step launch checklist run korte hobe। Ete sign-in, team roles, pledges, card payments, receipts, refunds, disputes, recorder actions, audit log, data exports, closing ebong payout flow check korte hobe।

Going Live (Once Registration Arrives):
Florida non-profit registration number ashle Stripe-ke live mode-e switch kora। Ekta $1 real payment ebong tarpor refund kore final verification check run kora।

Treasurer Handover:
Shobkichu live howar por organization-er treasurer-ke website kivabe manage/run korte hobe, tar upor ekta 30 miniter walkthrough ba handover session deya।
```

---

## ২. বিস্তারিত ধাপ ও চেকলিস্ট (Detailed Breakdown & Action Plan)

### ধাপ ১: থার্ড-পার্টি অ্যাকাউন্ট সেটআপ (Third-Party Accounts Setup)

ক্লায়েন্ট ফান্ডের অফিশিয়াল ইমেইল (যেমন: `treasurer@yourdomain.org`) ব্যবহার করে ওনার (Owner) হিসেবে অ্যাকাউন্ট খুলবেন এবং ডেভেলপারকে টিম মেম্বার হিসেবে অ্যাক্সেস দিবেন।

- [ ] **ডোমেইন (Domain):** অর্গানাইজেশনের নামে ডোমেইন রেজিস্ট্রেশন করা।
- [ ] **Supabase (Database):** ডাটাবেজের জন্য Supabase প্রজেক্ট তৈরি (টেস্ট এবং লাইভ প্রজেক্ট)।
- [ ] **Stripe (Payments):** নন-প্রফিট লিগ্যাল নাম ও EIN দিয়ে Stripe অ্যাকাউন্ট ওপেন (শুরুতে Test mode-এ থাকবে)।
- [ ] **Resend (Emails):** ট্রানজ্যাকশনাল ইমেইল পাঠানোর জন্য Resend অ্যাকাউন্ট ওপেন।
- [ ] **Cloudflare Turnstile (Bot Protection):** ফর্ম স্প্যাম ঠেকানোর জন্য সাইট কী ও সিক্রেট কী নেওয়া।
- [ ] **Netlify (Hosting):** প্রজেক্ট হোস্ট করার জন্য Netlify অ্যাকাউন্ট ও টিম অ্যাক্সেস।

---

### ধাপ ২: সার্ভিস ইন্টিগ্রেশন ও লিঙ্কিং (Service Integration & Linking)

ওয়েবসাইট কোডবেসের সাথে সমস্ত ক্লাউড সার্ভিসের সংযোগ স্থাপন করা।

- [ ] **এনভায়রনমেন্ট ভেরিয়েবল (.env / Netlify Env):**
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`
  - `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO`, `TREASURER_EMAIL`
  - `LOG_SALT`
- [ ] **কাস্টম ডোমেইন ও DNS কনফিগারেশন:** Netlify-তে কাস্টম ডোমেইন যুক্ত করা ও SSL/HTTPS নিশ্চিত করা।
- [ ] **Email Sender Verification:** Resend-এ ডোমেইন ভেরিফিকেশনের জন্য DNS রেকর্ডস (SPF, DKIM, DMARC `p=none`) সেট করা।

---

### ধাপ ৩: কোড রিভিউ ও সিকিউরিটি হার্ডেনিং (Fixes Review & Hardening)

ক্লায়েন্টের করা পূর্ববর্তী ফিক্সগুলো পর্যালোচনা ও সিস্টেমের সুরক্ষা নিশ্চিত করা।

- [x] **Neighborhood Grouping:** এলাকাভিত্তিক অনুদানের চার্ট ও গ্রুপিং লজিক শতভাগ ভেরিফাইড।
- [x] **Server-side Registration Rule:** ক্লায়েন্ট-সাইড ভ্যালিডেশনের উপর নির্ভর না করে সার্ভারলেস ফাংশনে (`pledge.mjs`, `giving.mjs`) ইনপুট ও লিমিট রুলস শতভাগ এনফোর্সড।
- [x] **Tamper-Proof Audit Log:** ডেটাবেজের `audit_log` এবং `activity_log` কোনো স্টাফ, অ্যাডমিন বা সার্ভার মডিফাই বা ডিলিট করতে পারে না (Append-only & trigger-based sealed, ভেরিফাইড)।

---

### ধাপ ৪: ডিপ্লয়মেন্ট ও সিকিউরিটি চেক (Deployment & Security Check)

- [ ] Netlify-তে প্রোডাকশন সাইট বিল্ড ও ডিপ্লয় করা।
- [ ] পোস্ট-ডিপ্লয় সিকিউরিটি ভেরিফিকেশন স্ক্রিপ্ট চালানো:
  ```powershell
  npm run verify -- https://yourdomain.org
  ```
- [ ] নিশ্চিত করা যাতে আউটপুটে **0 failed** আসে (HTTPS, সিকিউরিটি হেডার CSP, HSTS, কী-লিক প্রোটেকশন চেক)।

---

### ধাপ ৫: ১৮-ধাপের টেস্ট মোড যাচাই (18-Step Test-Mode Run)

আসল সার্ভিসগুলো কানেক্ট করে টেস্ট মোডে [docs/LAUNCH_CHECKLIST.md](file:///c:/Users/Nirob/project/community-fund-website/docs/LAUNCH_CHECKLIST.md) এর পুরো ১৮টি ধাপ সফলভাবে টেস্ট করা:

1. [ ] **Sign-in Flow:** ট্রেজারার ও টিম মেম্বারদের ইমেইল ওটিপি (OTP) লগইন।
2. [ ] **Team Roles:** Treasurer, Recorder, Auditor ও Temporary Developer রোল পারমিশন চেক।
3. [ ] **Pledges:** এককালীন ও অফলাইন প্লেজ সংরক্ষণ।
4. [ ] **Card Payments:** Stripe টেস্ট কার্ড দিয়ে সফল পেমেন্ট ও Webhook রিসিপ্ট এন্ট্রি।
5. [ ] **Receipts & Fees:** পেমেন্টের রসিদ এবং Stripe প্রসেসিং ফি খরচের খাতায় যোগ হওয়া।
6. [ ] **Refunds & Disputes:** কার্ড রিফান্ড এবং চার্জব্যাক ডিসপিউট ট্র্যাকিং।
7. [ ] **Recorder Actions:** ক্যাশ/চেক রসিদ ও অফলাইন প্লেজ এন্ট্রি।
8. [ ] **Audit Log Verification:** প্রতিটি কাজের সঠিক অডিট হিস্ট্রি তৈরি হওয়া।
9. [ ] **Data Exports:** ৮ ধরণের CSV রিপোর্ট ডাউনলোড করা।
10. [ ] **Closing & Payout Flow:** ফান্ড ক্লোজিং ও পাই-পয়সা পর্যন্ত রিফান্ড শেয়ার ক্যালকুলেশন।

---

### ধাপ ৬: লাইভ হওয়া (Going Live - Registration Arrives)

ফ্লোরিডার চ্যারিটি/নন-প্রফিট রেজিস্ট্রেশন (FDACS) নম্বর হাতে পাওয়ার পর:

- [ ] অ্যাডমিন প্যানেল (`/admin/` > Settings)-এ FDACS রেজিস্ট্রেশন নম্বর বসানো।
- [ ] Stripe ড্যাশবোর্ড থেকে লাইভ কী (Live API Keys & Webhook Secret) সংগ্রহ করে Netlify-তে সেট করা।
- [ ] **"Open online card payments"** চালু করা।
- [ ] একটি **$1 আসল কার্ড পেমেন্ট** করে টেস্ট করা এবং সফল হলে সাথে সাথে সেটি **রিফান্ড** করে দিয়ে লাইভ ট্রানজ্যাকশন চূড়ান্তভাবে যাচাই করা।

---

### ধাপ ৭: ট্রেজারার হ্যান্ডওভার সেশন (Treasurer Handover)

সাইট পুরোপুরি লাইভ হওয়ার পর অর্গানাইজেশনের ট্রেজারারকে সাইট পরিচালনার দায়িত্ব বুঝিয়ে দেওয়া:

- [ ] ৩০ মিনিটের একটি হ্যান্ডওভার ওয়াকথ্রু / ট্রেনিং সেশন পরিচালনা করা।
- [ ] কীভাবে লগইন করতে হবে, অফলাইন টাকা ও খরচের হিসাব ঢোকাতে হবে, সিএসভি ডাউনলোড করতে হবে তা দেখানো।
- [ ] [docs/HANDOVER.md](file:///c:/Users/Nirob/project/community-fund-website/docs/HANDOVER.md) অনুযায়ী সমস্ত সিক্রেট কী রোটেশন এবং ডেভেলপার অ্যাক্সেস রিমুভ নিশ্চিত করা।
