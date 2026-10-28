// scripts/set-admin-password.mjs
// Sets or updates a staff member's password in Supabase Auth using the service role key.
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";

dotenv.config();

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env");
  process.exit(1);
}

const sb = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = (process.argv[2] || process.env.TREASURER_EMAIL || "nirobhossainalip@gmail.com").trim().toLowerCase();
const password = process.argv[3] || "12345678";

if (!password || password.length < 6) {
  console.error("Password must be at least 6 characters long.");
  process.exit(1);
}

async function run() {
  console.log(`Setting password for staff member: ${email}...`);

  // Find user in Supabase Auth
  let targetUser = null;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) {
      console.error("Error listing users:", error.message);
      process.exit(1);
    }
    const hit = data.users.find((u) => (u.email || "").toLowerCase() === email);
    if (hit) {
      targetUser = hit;
      break;
    }
    if (data.users.length < 200) break;
  }

  if (!targetUser) {
    console.log(`User ${email} not found in Supabase Auth. Creating new user...`);
    const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (createErr) {
      console.error("Failed to create user:", createErr.message);
      process.exit(1);
    }
    targetUser = newUser.user;
    console.log(`Created user: ${targetUser.id}`);
  } else {
    // Update existing user's password
    const { error: updateErr } = await sb.auth.admin.updateUserById(targetUser.id, {
      password,
      email_confirm: true,
    });
    if (updateErr) {
      console.error("Failed to update password:", updateErr.message);
      process.exit(1);
    }
    console.log(`Successfully updated password for user: ${targetUser.id} (${email})`);
  }

  // Ensure user is in public.admins
  const { data: adminRecord, error: adminQueryErr } = await sb
    .from("admins")
    .select("*")
    .eq("user_id", targetUser.id)
    .maybeSingle();

  if (adminQueryErr) {
    console.error("Error checking public.admins table:", adminQueryErr.message);
  } else if (!adminRecord) {
    console.log("Adding user to public.admins as treasurer...");
    const { error: insertErr } = await sb.from("admins").insert({
      user_id: targetUser.id,
      role: "treasurer",
      display_name: "Admin",
      active: true,
    });
    if (insertErr) {
      console.error("Failed to insert admin record:", insertErr.message);
      process.exit(1);
    }
    console.log("User registered in public.admins as active treasurer.");
  } else {
    console.log(`Admin record found: Role = ${adminRecord.role}, Active = ${adminRecord.active}`);
    if (!adminRecord.active) {
      console.log("Reactivating admin record...");
      await sb.from("admins").update({ active: true }).eq("user_id", targetUser.id);
    }
  }

  console.log(`\nAll done! You can now sign in at http://localhost:8888/admin/`);
  console.log(`Email:    ${email}`);
  console.log(`Password: ${password}`);
}

run().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
