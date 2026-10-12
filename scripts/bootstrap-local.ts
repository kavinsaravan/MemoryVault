import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const destination = ".env.local";
if (existsSync(destination) && !process.argv.includes("--force")) {
  throw new Error(`${destination} already exists; use --force only after a local database reset`);
}
const output = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8" });
const env = Object.fromEntries(output.split(/\r?\n/u).filter(line => line.includes("=")).map(line => {
  const index = line.indexOf("=");
  return [line.slice(0, index), line.slice(index + 1).replace(/^"|"$/gu, "")];
}));
const url = env.API_URL;
const secret = env.SERVICE_ROLE_KEY ?? env.SECRET_KEY;
const publishable = env.ANON_KEY ?? env.PUBLISHABLE_KEY;
if (!url || !secret || !publishable) throw new Error("Supabase local status did not provide API_URL and both API keys");
const email = "demo-user@company.example";
const password = randomBytes(20).toString("base64url");
const admin = createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const result = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (result.error || !result.data.user) throw new Error(result.error?.message ?? "Auth user creation failed");
const lines = [
  `SUPABASE_URL=${url}`,
  `SUPABASE_SECRET_KEY=${secret}`,
  `SUPABASE_PUBLISHABLE_KEY=${publishable}`,
  `MEMORYVAULT_USER_ID=${result.data.user.id}`,
  `MEMORYVAULT_USER_EMAIL=${email}`,
  `MEMORYVAULT_DEMO_PASSWORD=${password}`,
  "MEMORYVAULT_MODE=protected",
];
writeFileSync(destination, lines.join("\n") + "\n", { mode: 0o600 });
process.stdout.write(`Created local Auth user ${email} and ${destination} (mode 0600).\n`);
