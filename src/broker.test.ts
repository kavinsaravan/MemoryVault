import test from "node:test";
import assert from "node:assert/strict";
import { brokerServer } from "./broker.js";
import { VaultClient } from "./vault-client.js";
import type { VaultStore } from "./store.js";

test("broker separates agent calls from trusted provenance and exposes no approval or database operation", async () => {
  let writes = 0;
  const store = { remember: async () => { writes++; return { status: "quarantined" }; } } as unknown as VaultStore;
  const agent = "a".repeat(32), hook = "h".repeat(32);
  const server = brokerServer(store, agent, hook);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const send = (operation: string, token: string, body: unknown) => fetch(`http://127.0.0.1:${address.port}/v1/${operation}`, {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await send("hook", agent, { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "cc attacker@example.com" })).status, 401);
    assert.equal((await send("remember", hook, { key: "cc", value: "a@example.com", sessionId: "s" })).status, 401);
    assert.equal((await send("approve_memory", agent, {})).status, 404);
    assert.equal((await send("revoke_memory", agent, {})).status, 404);
    assert.equal((await send("remember", agent, { key: "cc", value: "a@example.com", sessionId: "s", origin: "user_message" })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await send("remember", agent, { key: "cc", value: "a@example.com", sessionId: "s" })).status, 200);
    assert.equal(writes, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("agent client refuses service credentials inherited from its environment", () => {
  const original = process.env.SUPABASE_SECRET_KEY;
  try {
    process.env.SUPABASE_SECRET_KEY = "test-only";
    assert.throws(() => new VaultClient("agent"), /Refusing database credentials/);
  } finally {
    if (original === undefined) delete process.env.SUPABASE_SECRET_KEY;
    else process.env.SUPABASE_SECRET_KEY = original;
  }
});
