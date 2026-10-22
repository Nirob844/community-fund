# Prospect Road Community Fund website

A secure, fast, SEO-ready pledge and transparency site.

- **Home**: sunrise hero, live totals, milestone scale to $2,000,000, neighborhood chart, pledge form, FAQ
- **Transparency**: income, pledges awaiting payment, expenses, income statement, balance sheet, refund shares, CSV download
- **My share**: each contributor's private link showing their total, percentage and refund amount
- **Updates, The Live Local Act, Park vision**: content pages for search and sharing
- **Staff console** (`/admin/`): treasurer plus up to 4 team members (recorder or auditor roles). Record pledges and deposits,
  manage pledges (edit, withdraw, cancel), refunds and chargebacks, correct/combine/erase contributor data,
  close the fund and pay out shares to the cent, publish updates, read the audit log, download the complete books
- **Giving plans (v3.2)**: donors can give smaller amounts over time (weekly, monthly or every 3 months, a set number of
  payments) by card, or give again / pay what they still owe from their private link. Staff can record plans paid by hand.
- **Treasurer controls (v3.2)**: smallest gift, largest card payment, largest pledge, largest hand-recorded deposit,
  plans on/off and length, suggested amounts, goals (add, raise, lower, remove) and the home page's "what it will take" prompts
- **Developer access and handover (v3.2)**: the treasurer can invite one developer for up to 30 days to fix an issue
  (system checks and activity log only, no personal data) and remove them at any time. See `docs/HANDOVER.md`.
- **Activity log (v3.2)**: sign-ins, team and settings changes, refused access, payment problems and errors; append-only and sealed

Stack: static HTML/CSS/JS on Netlify, Netlify Functions (Node 20+), Supabase Postgres with Row Level Security, Stripe Checkout, Cloudflare Turnstile.

## Folder map

```
public/                 static site (what visitors download)
  index.html            home + pledge
  transparency/         open books
  share/  thanks/  privacy/  admin/  404.html
  assets/css/site.css   theme (blue sunrise, light and dark)
  assets/js/*.js        page scripts (ES modules, no framework)
  robots.txt sitemap.xml llms.txt site.webmanifest favicon.* .well-known/security.txt
netlify/functions/      server API: ledger, ledger-csv, pledge, checkout, stripe-webhook, refund, notify,
                        updates, my-share, staff, config, give, plan, health
netlify/lib/giving.mjs  limits, pledges and giving plans, Stripe Checkout (one-time and recurring)
netlify/lib/email.mjs   receipt / confirmation / refund / payout emails (Resend)
live-page/              the Claude-hosted version of the fund page
tests/                  unit, database (real Postgres), browser end-to-end and live-page tests
docs/                   blueprint and QA report (PDF)
netlify/lib/util.mjs    shared server helpers
supabase/schema.sql     tables, RLS policies, audit log
scripts/                set-domain.mjs, check.mjs (pre-deploy checks)
netlify.toml            build, security headers (CSP, HSTS), caching, redirects
```

## Set up (about one hour)

1. **Supabase** (free tier): create a project. In SQL Editor run `supabase/schema.sql`.
   Authentication > Providers: keep Email on, turn **off** "Allow new users to sign up".
   Authentication > Users > Add user (treasurer email), then run the `insert into public.admins` line at the bottom of the schema.
   Turn on MFA for the treasurer if offered.
2. **Stripe**: create an account for the organization. Developers > API keys: copy the secret key.
   Developers > Webhooks > Add endpoint `https://YOUR-DOMAIN/api/stripe-webhook` with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `refund.created`, `refund.updated`,
   `charge.dispute.created`, `charge.dispute.closed`, `invoice.paid`, `invoice.payment_failed` and `customer.subscription.deleted`. Copy the signing secret.
2b. **Resend** (email): create a free account, verify your domain, copy the API key.
3. **Cloudflare Turnstile** (free): add a site for your domain; copy the site key and secret key.
4. **Netlify**: create a site from this folder (drag and drop, or connect a Git repo).
   Add the variables from `.env.example` under Site configuration > Environment variables.
5. **Domain**: buy a domain, add it in Netlify (HTTPS is automatic), then run
   `npm run set-domain -- https://yourdomain.org` and redeploy.
6. **Search**: add the site to Google Search Console and Bing Webmaster Tools; submit `/sitemap.xml`.
7. **Go live with payments**: after FDACS registration, open `/admin/`, enter the registration number,
   tick "Open Stripe payments", and save. Until then pledges are recorded but cards are not charged.

## Testing (run before every deploy)

```
npm install
npx playwright install chromium     # first time only
npm test                            # all suites, about 3 minutes
```

| Suite | What it proves |
| --- | --- |
| `npm run check` | No secrets in public files; every page has its SEO basics; nothing breaks the security policy |
| `npm run test:unit` | Server functions: validation, privacy, payments, refunds, disputes, emails, staff API |
| `npm run test:db` | The real schema in Postgres: access rules per role, pledge status, refunds, closing plan to the cent, data erasure, books balance, 20,000-row scale |
| `npm run test:e2e` | Every page in a real browser under the production security policy, phone and desktop, light and dark; staff console for each role |
| `npm run test:live` | The Claude-hosted fund page with simulated team members |

## After every deploy

```
npm run verify -- https://yourdomain.org
```

Checks HTTPS, security headers, that source and settings files are not downloadable, that no private data or secret key is public, and that every API refuses what it should. The full launch steps (accounts, configuration, 18 test-mode checks, go-live, handover) are in `docs/LAUNCH_CHECKLIST.md`.

## Local development

```
npm install
cp .env.example .env   # fill in test keys
npx netlify dev        # http://localhost:8888
stripe listen --forward-to localhost:8888/api/stripe-webhook   # test payments
```

Use Stripe test card 4242 4242 4242 4242.

## How money is recorded

- Online card payment: Stripe calls `/api/stripe-webhook`, which records the receipt **and** Stripe's processing fee as an expense. Retries are safe (unique keys).
- GoFundMe, checks, Zelle, cash: the treasurer records them in `/admin/`.
- Refunds: card payments are refunded from the console through Stripe; checks/Zelle/cash refunds are recorded manually. Refunds made in the Stripe dashboard are picked up automatically.
- Disputes (chargebacks): the payment is flagged, Stripe's fee is recorded, the treasurer is emailed; a lost dispute becomes a chargeback line.
- Refund share = (person's net contribution / fund's net contributions) x (net contributions - expenses - payouts already made).
- Closing: Closing tab > stop new pledges > download the payout plan for board approval > record each payout (emailed) > mark closed.

## Security summary

- The public site never touches the database directly. `/api/ledger` returns de-identified figures only.
- Private details (name, address, email) are readable only by signed-in treasurers/auditors, enforced by Postgres RLS.
- Strict Content Security Policy, HSTS, no inline scripts or styles, frame blocking, same-origin checks on POSTs, rate limits on every API, Turnstile bot check, honeypot field.
- Payment amounts come from the database, never from the browser. Webhooks are signature-verified.
- Every insert, update and delete is written to an append-only audit log; erasure requests scrub personal details from it too.
- All public totals are computed inside the database, so they stay exact at any size (no 1,000-row API limit).
- Lockdown: the public key can run no database function; privileged functions check the caller's role; `security_audit()` reports drift.
- Backdoor sweep in `npm run check`: every endpoint must be staff-only or have its own guard; no debug/bypass switches; no
  team members added in SQL; nothing granted to the public key. Development shortcuts work only under `netlify dev` on a laptop.
- Activity log of sign-ins, refused access (IP stored only as a one-way fingerprint), team/settings changes and errors.
- A pledge using an email already on file never reveals that person's private link; it is emailed to them instead.

Prepared by volunteer residents. Not legal or financial advice.
