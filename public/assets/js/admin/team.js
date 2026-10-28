// Team Management domain module (treasurer only, through /api/staff)
import { $, fill, h } from "../common.js";
import { state, note, setBtnLoading, btn, confirmAct } from "./context.js";

async function staffApi(method, body) {
  const { data: { session: s } } = await state.sb.auth.getSession();
  const r = await fetch("/api/staff", {
    method,
    headers: { authorization: "Bearer " + s.access_token, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Could not update the team.");
  return d;
}

const patchStaff = (body) => async () => {
  try {
    await staffApi("PATCH", body);
    return {};
  } catch (e) {
    return { error: e };
  }
};

export function initTeam() {
  state.loaders.team = async () => {
    try {
      const d = await staffApi("GET");
      if ($("seatNote")) $("seatNote").textContent = `· ${d.seatsUsed} of ${d.seats} seats used`;
      fill($("teamRows"), d.staff.map((m) => {
        const dev = m.role === "developer";
        const status = dev ? (m.active ? `Access until ${new Date(m.accessExpiresAt).toLocaleString()}` : m.expired ? "Access ended" : "Removed") : (m.active ? "Active" : "Inactive");
        const acts = m.userId === state.session.user.id ? h("span", { class: "hint" }, "You")
          : dev ? [m.active ? btn("Remove access now", (ev) => confirmAct(ev.currentTarget, "Remove the developer's access now?", patchStaff({ userId: m.userId, active: false }), () => state.loaders.team?.()), "btn small danger") : null,
              btn(m.active ? "Extend 7 days" : "Give 7 more days", (ev) => confirmAct(ev.currentTarget, "Allow access for 7 days from now?", patchStaff({ userId: m.userId, extendDays: 7 }), () => state.loaders.team?.()))]
          : btn(m.active ? "Deactivate" : "Reactivate", (ev) => confirmAct(ev.currentTarget, m.active ? "Deactivate?" : "Reactivate?", patchStaff({ userId: m.userId, active: !m.active }), () => state.loaders.team?.()));
        return h("tr", {},
          h("td", {}, m.displayName || "—"),
          h("td", {}, m.email),
          h("td", {}, h("span", { class: "pill role-" + m.role }, m.role)),
          h("td", { class: "hint" }, m.lastSignIn ? new Date(m.lastSignIn).toLocaleDateString() : "Never"),
          h("td", {}, status, dev && m.purpose ? h("div", { class: "hint" }, "Issue: " + m.purpose) : null),
          h("td", { class: "r" }, acts)
        );
      }));
    } catch (e) {
      note($("tMsg"), e.message, "err");
    }
  };

  $("tRole")?.addEventListener("change", () => {
    const dev = $("tRole").value === "developer";
    if ($("tDevBox")) $("tDevBox").hidden = !dev;
    if ($("tAdd")) $("tAdd").textContent = dev ? "Invite developer" : "Add team member";
  });

  $("tForm")?.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Saving...");
    try {
      const dev = $("tRole").value === "developer";
      const r = await staffApi("POST", {
        email: $("tEmail").value.trim(),
        displayName: $("tName").value.trim(),
        role: $("tRole").value,
        ...(dev ? { days: Number($("tDays").value), purpose: $("tPurpose").value.trim() } : {})
      });
      done(true);
      note($("tMsg"), dev
        ? `Developer invited until ${new Date(r.accessExpiresAt).toLocaleString()}. They see system checks and the activity log only, and you can remove them at any time.`
        : "Added. They can now sign in at /admin/ with a code sent to their email.");
      $("tEmail").value = "";
      $("tName").value = "";
      $("tPurpose").value = "";
      state.loaders.team?.();
    } catch (e) {
      done(false);
      note($("tMsg"), e.message, "err");
    }
  });
}
