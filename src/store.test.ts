import assert from "node:assert/strict";
import test from "node:test";
import { VaultStore } from "./store.js";
const config = { url: "https://test.supabase.co", secretKey: "test", userId: "owner", userEmail: "owner@example.com", mode: "protected" as const };

test("recall logs tool reads separately from injection and records quarantined items as withheld", async () => {
  const records: any[] = [];
  const candidates = [
    { id: "active", key: "cc", value: "friend@example.com", status: "active", origin: "user_message" },
    { id: "held", key: "cc", value: "attacker@example.com", status: "quarantined", origin: "document" },
    { id: "revoked", key: "cc", value: "old@example.com", status: "revoked", origin: "user_message" },
  ];
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, order: async () => ({ data: candidates, error: null }) };
  const store = new VaultStore(config);
  Object.defineProperty(store, "db", { value: { from: (table: string) => table === "memories" ? query : {
    insert: async (events: any[]) => { records.push(...events); return { data: null, error: null }; },
  } } });
  const recalled = await store.recall(undefined, "fresh-session");
  assert.deepEqual(recalled.map(m => m.id), ["active"]);
  assert.deepEqual(records.map(e => e.event), ["recalled_by_tool", "withheld", "withheld"]);
  assert.ok(records.every(e => e.session_id === "fresh-session"));
});

test("context size limit logs only memories actually included as injected", async () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({ id: String(i), key: "project_context", value: "x".repeat(320), status: "active" }));
  const records: any[] = [];
  const query = { select() { return this; }, eq() { return this; }, in() { return this; }, order: async () => ({ data: candidates, error: null }) };
  const store = new VaultStore(config);
  Object.defineProperty(store, "db", { value: { from: (table: string) => table === "memories" ? query : {
    insert: async (events: any[]) => { records.push(...events); return { data: null, error: null }; },
  } } });
  const included = await store.recall(undefined, "s", "injected");
  assert.ok(included.length < 100);
  assert.ok(included.map(m => `${m.key}: ${m.value}\n`).join("").length <= 7500);
  assert.equal(records.filter(e => e.event === "injected").length, included.length);
  assert.equal(records.filter(e => e.deciding_rule === "CONTEXT-LIMIT").length, 100 - included.length);
});
