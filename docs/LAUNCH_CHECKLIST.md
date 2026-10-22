# Launch checklist

Work through this in order. Tick each box. Everything in Phase C uses **test mode**:
no real money moves. Keep a copy of this file with the date and initials for the board.

## Phase A: Accounts (all in the fund's name, not a person's)

Use a shared fund mailbox (for example `treasurer@yourdomain.org`) as the login for every service, with two-factor authentication on. Store the passwords in a password manager the board can access.

- [ ] Domain registered (for example `prospectroadfund.org`) with auto-renew on
- [ ] Netlify account and site
- [ ] Two Supabase projects (region: US East): **fund-test** for Phase C and **fund-live** for real money (Pro plan for daily backups)
- [ ] Stripe account opened with the nonprofit's legal name and EIN (stays in test mode until Phase D)
- [ ] Resend account, domain verified (SPF, DKIM, and a DMARC record at least `p=none`)
- [ ] Cloudflare Turnstile site key for the domain

## Phase B: Configuration

**Supabase**
- [ ] SQL Editor: run `supabase/schema.sql` (safe to run again later)
- [ ] Authentication › Providers › Email: on. **"Allow new users to sign up": off**
- [ ] Authentication › Email templates › Magic Link: replace the link with the code: `Your sign-in code is {{ .Token }}`
- [ ] Authentication › SMTP: use Resend's SMTP so sign-in codes aren't limited to Supabase's built-in few-per-hour
- [ ] Authentication › URL configuration: site URL = your domain
- [ ] Add the treasurer under Authentication › Users, then run the `insert into public.admins …` line at the end of the schema
- [ ] Database › Advisors › Security: no errors

**Netlify**
- [ ] Deploy the site folder; set every variable from `.env.example`
- [ ] Domain added, HTTPS certificate issued, "Force HTTPS" on
- [ ] `npm run set-domain -- https://yourdomain.org`, then redeploy
- [ ] `npm run verify -- https://yourdomain.org` shows **0 failed**

**Stripe (test mode)**
- [ ] Webhook endpoint `https://yourdomain.org/api/stripe-webhook` with: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated`, `charge.dispute.created`, `charge.dispute.closed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`
- [ ] Test secret key and webhook secret in Netlify; redeploy

## Phase C: End-to-end tests with the real services (test mode)

| # | Do this | Expected |
|---|---|---|
| 1 | Treasurer: open `/admin/`, request a code | Code arrives within a minute from your domain; sign-in works |
| 2 | Team tab: add a recorder and an auditor | They can sign in; recorder sees Record; auditor sees no Record tab |
| 3 | Try to sign in with an email that isn't on the team | No code is sent; same message shown |
| 4 | Settings: enter registration `CH00000` (test), tick online payments | Saves; footer shows the state disclosure |
| 5 | Home: pledge $25 with your own email | Confirmation email with private link; pledge appears in console |
| 6 | Pay with card `4242 4242 4242 4242` | Thank-you page; receipt email; deposit and Stripe fee appear; pledge shows Paid; public ledger updates within a minute |
| 7 | Pledge again with the **same email** | No link on screen; it is emailed instead |
| 8 | Money tab: refund $10 of that card payment | Stripe shows the refund; refund line and email; pledge shows Partly paid |
| 9 | In the Stripe dashboard, refund another $5 | Appears automatically in the console |
| 10 | Pay a new pledge with `4000 0000 0000 0259` (creates a dispute) | Payment marked "Disputed"; dispute fee as expense; alert email to treasurer |
| 11 | In Stripe test mode, lose the dispute | Chargeback line; pledge re-opens |
| 12 | Recorder: record a $50 check for a new person with email | Receipt email; Entered by shows the recorder |
| 13 | Recorder: try to delete it | No delete button; database refuses |
| 14 | People: edit a name, combine two records, erase one | Public lines update; erased person no longer appears anywhere |
| 15 | Audit tab | "Integrity verified"; every step above is listed with who did it |
| 16 | Download every export; open the journal | Debits equal credits |
| 17 | Closing tab: start closing, download plan, record one payout, reopen | Pledge form closes and reopens; payout email arrives |
| 18 | Phone: repeat 5 and 6 on a phone | Works; nothing is cut off |
| 19 | Home: choose "Smaller payments over time", $10 weekly × 3, pay with `4242 4242 4242 4242` | Plan set-up email; first receipt says "payment 1 of 3"; plan shows Active in Pledges › Giving plans |
| 20 | In Stripe test mode, use a test clock (or "Advance time") to bill the next two weeks | Receipts 2 and 3; plan shows Completed; Stripe shows the subscription canceled (no 4th charge) |
| 21 | Start another plan, then stop it from the private link | Stop email; no more charges; pledge shrinks to what was paid |
| 22 | Settings: lower the largest card payment to $50, then pledge $120 one-time and pay | Payment page asks for $50; $70 stays owed; private link offers "Pay what I still owe" |
| 23 | Settings: change a goal amount, add a goal, set a target date, switch prompts off and on | Home page scale and "What it will take" update within a minute |
| 24 | Recorder: record a $500 cash deposit with the deposit limit at $250 | Refused with the limit message; treasurer raises the limit; it saves |
| 25 | Team: invite a developer for 1 day; sign in as them | Only "System and activity" is visible; no people, money or settings can be changed |
| 26 | Remove the developer; try to sign in as them again | No code arrives; "Access refused" and "Developer removed" are in the activity log |
| 27 | System and activity › Run the checks | Every check passed; activity log "Integrity verified" |

## Phase D: Go live

- [ ] Run Phase B's Supabase steps on **fund-live** and point Netlify's Supabase variables at it (the audit log can't be wiped, by design, so live starts in a clean project)
- [ ] Florida registration number received (real one entered in Settings)
- [ ] Stripe: activate the account, switch to **live** keys and a **live** webhook (same events); redeploy
- [ ] One real $1 payment and $1 refund from a board member's card
- [ ] `npm run verify -- https://yourdomain.org` shows 0 failed
- [ ] Search Console and Bing Webmaster Tools: verify the domain, submit `/sitemap.xml`
- [ ] Update flyers and QR codes to the new domain; publish the first Update

## Phase E: Handover (30 minutes with the treasurer)

Follow `docs/HANDOVER.md` step by step (account ownership, new keys, confirm handover in the console). Then:


- [ ] Record a pledge, a deposit, an expense; email a receipt
- [ ] Refund (card and check); what a dispute email means and how to respond in Stripe
- [ ] Add and deactivate a team member; invite and remove a developer
- [ ] Change limits and goals; read the activity log and run the system checks
- [ ] Monthly routine: reconcile bank to "Cash on hand", download the journal, check audit integrity
- [ ] Where the passwords and this checklist live
