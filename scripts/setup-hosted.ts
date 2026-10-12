import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const file = ".env.local";
const index = process.argv.indexOf("--project-ref");
const projectRef = index < 0 ? "" : process.argv[index + 1] ?? "";
const ownerEmailIndex = process.argv.indexOf("--owner-email");
const email = ownerEmailIndex < 0 ? "demo-user@company.example" : (process.argv[ownerEmailIndex + 1] ?? "").trim().toLowerCase();
if (!/^[a-z0-9]{20}$/u.test(projectRef)) {
  throw new Error("Usage: npm run setup:hosted -- --project-ref YOUR_PROJECT_REF");
}
if (!/^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u.test(email)) throw new Error("--owner-email must be a valid email address");
if (existsSync(file)) throw new Error(`${file} already exists; setup will not overwrite credentials`);

type ApiKey = { name: string; type: string; api_key: string };
const keys = JSON.parse(execFileSync("supabase", ["projects", "api-keys", "--project-ref", projectRef, "-o", "json"], {
  encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
})) as ApiKey[];
const publishableKey = keys.find(key => key.name === "anon")?.api_key ?? keys.find(key => key.type === "publishable")?.api_key;
const secretKey = keys.find(key => key.name === "service_role")?.api_key ?? keys.find(key => key.type === "secret")?.api_key;
if (!publishableKey || !secretKey) throw new Error("The project needs a publishable and secret API key");
const url = `https://${projectRef}.supabase.co`;
const admin = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
const schema = await admin.from("memories").select("id").limit(1);
if (schema.error) throw new Error(`MemoryVault schema is not ready: ${schema.error.message}. Link the project and run supabase db push first.`);

const password = randomBytes(24).toString("base64url");
const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
if (created.error || !created.data.user) throw new Error(created.error?.message ?? "Could not create demo user");
const lines = [
  `SUPABASE_URL=${url}`,
  `SUPABASE_PUBLISHABLE_KEY=${publishableKey}`,
  `SUPABASE_SECRET_KEY=${secretKey}`,
  `MEMORYVAULT_USER_ID=${created.data.user.id}`,
  `MEMORYVAULT_USER_EMAIL=${email}`,
  `MEMORYVAULT_DEMO_PASSWORD=${password}`,
  "MEMORYVAULT_MODE=protected",
];
writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600, flag: "wx" });
process.stdout.write(`Configured ${url} and created ${email}. Credentials are in ${file} (mode 0600).\n`);
