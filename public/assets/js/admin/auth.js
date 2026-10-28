// Authentication domain module (password, OTP, reset, remember email, sign-out)
import { $ } from "../common.js";
import { state, note, showToast, setBtnLoading, EMAIL } from "./context.js";

const SAVED_EMAIL_KEY = "fund-staff-email";

export function initAuth(bootCallback) {
  // Password toggle eye buttons
  document.querySelectorAll(".eye-btn[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.dataset.toggle;
      const inp = $(targetId);
      if (!inp) return;
      const isPass = inp.type === "password";
      inp.type = isPass ? "text" : "password";
      btn.setAttribute("aria-label", isPass ? "Hide password" : "Show password");
      btn.innerHTML = isPass
        ? `<svg class="eye-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        : `<svg class="eye-icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    });
  });

  // Auto-fill remembered email
  try {
    const savedEmail = localStorage.getItem(SAVED_EMAIL_KEY);
    if (savedEmail && $("pEmail")) {
      $("pEmail").value = savedEmail;
      if ($("rememberEmail")) $("rememberEmail").checked = true;
      $("pPass")?.focus();
    }
  } catch {}

  // Password Login
  $("passForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Signing in...");
    const email = $("pEmail").value.trim().toLowerCase();
    const password = $("pPass").value;
    if (!EMAIL.test(email)) { done(false); return note($("authMsg"), "Enter a valid email address.", "err"); }
    if (!password) { done(false); return note($("authMsg"), "Enter your password.", "err"); }

    if ($("rememberEmail")?.checked) {
      try { localStorage.setItem(SAVED_EMAIL_KEY, email); } catch {}
    } else {
      try { localStorage.removeItem(SAVED_EMAIL_KEY); } catch {}
    }

    const { error } = await state.sb.auth.signInWithPassword({ email, password });
    if (error) {
      done(false);
      const msg = error.message.includes("Invalid login credentials")
        ? "Invalid email or password. Please check your credentials."
        : error.message;
      return note($("authMsg"), msg, "err");
    }
    done(true);
    bootCallback();
  });

  // OTP view toggles
  $("useOtp")?.addEventListener("click", () => {
    $("passForm").hidden = true;
    $("emailForm").hidden = false;
    $("aEmail").value = $("pEmail").value;
    $("aEmail").focus();
  });

  $("usePass")?.addEventListener("click", () => {
    $("emailForm").hidden = true;
    $("codeForm").hidden = true;
    $("forgotForm").hidden = true;
    $("passForm").hidden = false;
    $("pEmail").value = $("aEmail").value || $("pEmail").value;
    $("pEmail").focus();
  });

  $("backToPass")?.addEventListener("click", () => {
    $("codeForm").hidden = true;
    $("emailForm").hidden = true;
    $("forgotForm").hidden = true;
    $("passForm").hidden = false;
    $("pEmail").focus();
  });

  $("forgotPassBtn")?.addEventListener("click", () => {
    $("passForm").hidden = true;
    $("forgotForm").hidden = false;
    $("fEmail").value = $("pEmail").value;
    $("fEmail").focus();
  });

  $("cancelForgot")?.addEventListener("click", () => {
    $("forgotForm").hidden = true;
    $("passForm").hidden = false;
    $("pEmail").focus();
  });

  $("forgotForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Sending link...");
    const email = $("fEmail").value.trim().toLowerCase();
    if (!EMAIL.test(email)) { done(false); return note($("authMsg"), "Enter a valid email address.", "err"); }
    const { error } = await state.sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + "/admin/",
    });
    done(!error);
    if (error) {
      return note($("authMsg"), error.message || "Could not send reset email.", "err");
    }
    note($("authMsg"), "Password reset link sent! Check your email inbox.");
  });

  $("emailForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Sending code...");
    const email = $("aEmail").value.trim().toLowerCase();
    if (!EMAIL.test(email)) { done(false); return note($("authMsg"), "Enter a valid email address.", "err"); }
    const { error } = await state.sb.auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: false,
        emailRedirectTo: window.location.origin + "/admin/"
      }
    });
    done(!error);
    $("codeForm").hidden = false;
    $("aCode").focus();
    note($("authMsg"), error && /rate/i.test(error.message)
      ? "Too many requests. Wait a minute and try again."
      : "If that email belongs to a team member, check your inbox. You can either click the sign-in link or enter the 6-digit code.");
  });

  $("codeForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Signing in...");
    const { error } = await state.sb.auth.verifyOtp({ email: $("aEmail").value.trim().toLowerCase(), token: $("aCode").value.trim(), type: "email" });
    if (error) { done(false); return note($("authMsg"), "That code didn't work or has expired. Request a new one.", "err"); }
    done(true);
    bootCallback();
  });

  $("changePassForm")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const done = setBtnLoading(btn, "Updating...");
    const newPass = $("newPass").value;
    const confirmPass = $("confirmPass").value;
    const msg = $("cpMsg");
    if (newPass.length < 6) { done(false); return note(msg, "Password must be at least 6 characters.", "err"); }
    if (newPass !== confirmPass) { done(false); return note(msg, "Passwords do not match.", "err"); }
    const { error } = await state.sb.auth.updateUser({ password: newPass });
    if (error) { done(false); return note(msg, error.message || "Could not update password.", "err"); }
    done(true, "✓ Updated");
    $("changePassForm").reset();
    note(msg, "Password updated successfully!");
    showToast("Password updated successfully!", "ok");
  });

  $("signOut")?.addEventListener("click", async (e) => {
    setBtnLoading(e.currentTarget, "Signing out...");
    try { await state.sb.rpc("log_activity", { act: "client.sign_out", info: { page: "admin" } }); } catch {}
    state.sb.auth.signOut();
  });
}
