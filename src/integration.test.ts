import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "@supabase/supabase-js";
import { loadConfig } from "./config.js";
import { VaultStore } from "./store.js";

const ready = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.MEMORYVAULT_DEMO_PASSWORD);

test("Supabase refuses active unconfirmed document memory and permits human confirmation", { skip: !ready }, async () => {
  const config = loadConfig();
  const store = new VaultStore({ ...config, mode: "protected" });
  const email = `approved+${randomUUID().slice(0, 8)}@company.example`;
  const session = randomUUID();
  const direct = await store.db.from("memories").insert({
    user_id: config.userId, key: "cc", value: email, origin: "document", status: "active", session_id: session,
  });
  assert.ok(direct.error, "database must reject unconfirmed document authority");

  await store.recordLedger({ sessionId: session, kind: "user_message", content: "Summarize this document" });
  await store.recordLedger({ sessionId: session, kind: "untrusted_read", sourceRef: "document:test", content: `Report recipient: ${email}` });
  const proposed = await store.remember({ key: "cc", value: email, sessionId: session });
  assert.equal(proposed.status, "quarantined");
  assert.ok(proposed.memoryId);

  const serverApproval = await store.db.rpc("approve_memory", { p_id: proposed.memoryId });
  assert.ok(serverApproval.error, "server role must not call the human approval RPC");

  const dashboardClient = createClient(config.url, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const login = await dashboardClient.auth.signInWithPassword({ email: config.userEmail, password: process.env.MEMORYVAULT_DEMO_PASSWORD! });
  assert.ifError(login.error);
  const approval = await dashboardClient.rpc("approve_memory", { p_id: proposed.memoryId });
  assert.ifError(approval.error);
  assert.equal(approval.data.status, "active");
  assert.equal(approval.data.confirmed_by, config.userId);

  const outbox = await store.sendReport({ recipients: [config.userEmail, email], body: "Synthetic test report", sessionId: randomUUID() });
  assert.deepEqual(outbox.blockedRecipients, []);
  assert.ok(outbox.sentRecipients.includes(email));
});

test("later user preference replaces earlier active recipient", { skip: !ready }, async () => {
  const config = loadConfig();
  const store = new VaultStore({ ...config, mode: "protected" });
  const first = `old+${randomUUID().slice(0, 8)}@company.example`;
  const next = `new+${randomUUID().slice(0, 8)}@company.example`;
  for (const email of [first, next]) {
    const session = randomUUID();
    await store.recordLedger({ sessionId: session, kind: "user_message", content: `From now on, cc ${email}` });
    const result = await store.remember({ key: "cc", value: email, sessionId: session });
    assert.equal(result.status, "active");
  }
  const outbox = await store.sendReport({ recipients: [config.userEmail, first, next], body: "Synthetic test report", sessionId: randomUUID() });
  assert.ok(outbox.blockedRecipients.includes(first));
  assert.ok(outbox.sentRecipients.includes(next));
});

test("a new project memory persists without authorizing report sharing", { skip: !ready }, async () => {
  const config = loadConfig();
  const store = new VaultStore({ ...config, mode: "protected" });
  const session = randomUUID();
  const context = `Apollo rollout ${randomUUID().slice(0, 8)}`;
  await store.recordLedger({ sessionId: session, kind: "user_message", content: `Remember ${context} as my project context` });
  const saved = await store.remember({ key: "project_context", value: context, sessionId: session });
  assert.equal(saved.status, "active");
  const recalled = await store.recall("project_context");
  assert.ok(recalled.some(memory => memory.value === context));
  const outbox = await store.sendReport({ recipients: ["outsider@example.com"], body: "Synthetic", sessionId: randomUUID() });
  assert.deepEqual(outbox.blockedRecipients, ["outsider@example.com"]);
});

test("email sharing exposes only marked active memories and can be revoked", { skip: !ready }, async () => {
  const config = loadConfig();
  const store = new VaultStore({ ...config, mode: "protected" });
  const owner = createClient(config.url, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const ownerLogin = await owner.auth.signInWithPassword({ email: config.userEmail, password: process.env.MEMORYVAULT_DEMO_PASSWORD! });
  assert.ifError(ownerLogin.error);
  const recipientEmail = `reader+${randomUUID().slice(0, 8)}@company.example`;
  const recipientPassword = randomUUID();
  const recipientUser = await store.db.auth.admin.createUser({ email: recipientEmail, password: recipientPassword, email_confirm: true });
  assert.ifError(recipientUser.error);
  const recipient = createClient(config.url, process.env.SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const recipientLogin = await recipient.auth.signInWithPassword({ email: recipientEmail, password: recipientPassword });
  assert.ifError(recipientLogin.error);

  const session = randomUUID();
  const context = `Shared project ${randomUUID().slice(0, 8)}`;
  await store.recordLedger({ sessionId: session, kind: "user_message", content: `Remember ${context} as my project context` });
  const saved = await store.remember({ key: "project_context", value: context, sessionId: session });
  assert.equal(saved.status, "active");
  assert.ok(saved.memoryId);

  const serverShare = await store.db.rpc("set_memory_shared", { p_id: saved.memoryId, p_shared: true });
  assert.ok(serverShare.error, "service role cannot call owner sharing RPC");
  const otherShare = await recipient.rpc("set_memory_shared", { p_id: saved.memoryId, p_shared: true });
  assert.ok(otherShare.error, "recipient cannot share another user's memory");
  assert.ifError((await owner.rpc("grant_memory_access", { p_email: recipientEmail })).error);
  assert.deepEqual((await recipient.rpc("list_shared_memories")).data, [], "private memory stays hidden");
  assert.ifError((await owner.rpc("set_memory_shared", { p_id: saved.memoryId, p_shared: true })).error);
  const visible = await recipient.rpc("list_shared_memories");
  assert.ifError(visible.error);
  assert.ok(visible.data.some((memory: { id: string }) => memory.id === saved.memoryId));
  const direct = await recipient.from("memories").select("id").eq("id", saved.memoryId);
  assert.deepEqual(direct.data, [], "recipient has no direct table access");
  assert.ifError((await owner.rpc("revoke_memory_access", { p_email: recipientEmail })).error);
  assert.deepEqual((await recipient.rpc("list_shared_memories")).data, [], "revocation takes effect immediately");
  if (recipientUser.data.user) await store.db.auth.admin.deleteUser(recipientUser.data.user.id);
});
