# Developer handover and later fixes

The fund must own everything and know every key. A developer builds and launches the
site, then hands it over. After that the treasurer can invite a developer back for a few days
to fix a problem and remove them at any time.

## 1. At handover (developer and treasurer together, about one hour)

Do these in order. Each step closes a way back in.

| # | Step | Done |
|---|---|---|
| 1 | Create the fund's shared mailbox (for example `treasurer@yourdomain.org`) with two-factor sign-in, and store its password in the board's password manager | ☐ |
| 2 | **Netlify**: invite the shared mailbox as Owner of the team, then remove the developer from the team | ☐ |
| 3 | **Supabase**: invite the shared mailbox as Owner of the organization, remove the developer, then reset the database password (Project Settings › Database) | ☐ |
| 4 | **Stripe**: the account must already be in the nonprofit's name; remove the developer under Settings › Team | ☐ |
| 5 | **Resend, Cloudflare (Turnstile), the domain registrar, GitHub**: owner is the shared mailbox; developer removed (or read-only on the code repository) | ☐ |
| 6 | **Change every key** so nothing the developer saw still works: Supabase › API › roll the service-role (secret) key; Stripe › Developers › roll the secret key and the webhook signing secret; Resend › new API key, delete the old; Turnstile › rotate secret; a new `LOG_SALT`. Paste the new values into Netlify › Environment variables and redeploy | ☐ |
| 7 | Run `npm run verify -- https://yourdomain.org`: 0 failed | ☐ |
| 8 | Staff console › System and activity › **Run the checks**: every check passed | ☐ |
| 9 | Staff console › System and activity › Developer handover: tick each step, enter the date the keys were changed, **Confirm handover complete**. This removes every developer's access at once and is written to the activity log | ☐ |
| 10 | Keep a copy of this page, dated and initialed, with the board minutes | ☐ |

## 2. Inviting a developer later to fix an issue

1. Staff console › **Team** › Role: *Developer* › choose how long (1 to 30 days) and describe the issue › **Invite developer**.
2. The developer signs in at `/admin/` with a code sent to their email. They see only **System and activity**:
   system checks, which services are configured (yes/no, never a key) and the activity log.
   They **cannot** see contributors, pledges, money, the audit history or emails, and cannot change anything.
3. If the fix needs account access (for example Netlify logs or the Supabase SQL editor), add them to that one
   service for the same period and remove them afterwards.
4. Their access ends on its own at the end date. Remove it sooner with **Remove access now** (they are also blocked
   from requesting sign-in codes). Extend with **Extend 7 days**.
5. When they are done, repeat step 6 above for any key they saw, then confirm the handover again.

Only one developer can have access at a time. Every invitation, removal, extension, sign-in and system check is in the activity log.

## 3. What protects the fund (built into the code)

- **No backdoors**: the pre-deploy check (`npm run check`) fails the build if any server endpoint lacks a staff check or
  its own guard, if a debug or bypass switch appears, if a team member is added in the database script, or if anything is
  granted to the public key. Development shortcuts work only on a laptop running `netlify dev`, never on the live site.
- **Database lockdown**: the public key can run no database function and read no table; every privileged function
  checks the caller's role itself; a security self-check lists anything that drifts.
- **Activity log**: sign-ins and sign-outs, downloads, team changes, settings and limit changes, handovers, refused
  access attempts (with a one-way fingerprint of the address), forged payment notices, payment failures and server
  errors. Append-only and sealed entry to entry; nobody (staff, server or database owner) can edit or delete it.
- **Audit log**: every change to people, pledges, money and settings, as before.
