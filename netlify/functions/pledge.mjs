// POST /api/pledge : record a pledge, either one gift or a giving plan of several smaller
// payments over time. Private details go to the contributors table only.
// Privacy: the private "my share" link is only ever shown on screen to a NEW contributor.
// If the email already belongs to someone, the link is emailed to that address instead,
// so typing someone else's email never reveals their link or their giving.
import { db, json, fail, sameOrigin, readJson, clean, publicLabel, verifyTurnstile, getSettings, onlineOpen } from "../lib/util.mjs";
import { validateGift, createPledge } from "../lib/giving.mjs";
import { sendEmail } from "../lib/email.mjs";

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,63}\.[^\s@]{2,24}$/;

export default async (req, context) => {
  if (req.method !== "POST") return fail(405, "Method not allowed");
  if (!sameOrigin(req)) return fail(403, "Forbidden");
  let b;
  try { b = await readJson(req); } catch (e) { return fail(e.status || 400, e.message); }

  if (b.website) return json({ ok: true });                      // honeypot: silently drop bots
  const name = clean(b.name, 80), email = clean(b.email, 120).toLowerCase(), address = clean(b.address, 160), area = clean(b.area, 60);
  if (!name || !address || !area) return fail(400, "Please fill in your name, street address and neighborhood.");
  if (!EMAIL.test(email)) return fail(400, "Please enter a valid email address.");
  const s = db();
  const st = await getSettings(s);
  let gift;
  try { gift = validateGift(b, st); } catch (e) { return fail(e.status || 400, e.message); }
  if (!(await verifyTurnstile(b.turnstileToken, context?.ip))) return fail(400, "Please complete the security check and try again.");

  try {
    let isNew = false;
    let { data: c, error } = await s.from("contributors").select("id, share_token, public_label").eq("email", email).maybeSingle();
    if (error) throw error;
    if (!c) {
      const ins = await s.from("contributors").insert({ full_name: name, email, address, area, public_label: publicLabel(name, b.show) })
        .select("id, share_token, public_label").single();
      if (ins.error?.code === "23505") {
        const again = await s.from("contributors").select("id, share_token, public_label").eq("email", email).single();
        if (again.error) throw again.error;
        c = again.data;
      } else if (ins.error) throw ins.error;
      else { c = ins.data; isNew = true; }
    }
    const { pledgeId, planId } = await createPledge(s, c.id, gift);
    const site = process.env.URL || "";
    const shareUrl = `${site}/share/?t=${c.share_token}`;
    await sendEmail({ to: email, kind: "pledge", contributorId: c.id, data: { name: isNew ? name.split(" ")[0] : c.public_label.split(" ")[0], amount: gift.amount, shareUrl, online: onlineOpen(st), plan: gift.plan } });
    return json({ ok: true, pledgeId, planId, amount: gift.amount, plan: gift.plan, shareUrl: isNew ? shareUrl : null, emailed: true }, 201);
  } catch (e) {
    if (e.status) return fail(e.status, e.message);
    console.error("pledge", e?.message);
    return fail(500, "We could not save your pledge. Please try again.");
  }
};

export const config = { path: "/api/pledge", rateLimit: { windowLimit: 8, windowSize: 60, aggregateBy: ["ip", "domain"] } };
