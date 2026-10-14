import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { VaultStore } from "./store.js";
import { processHook, type HookInput } from "./process-hook.js";
import { MEMORY_KEYS } from "./gates.js";

export function tokenMatches(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export const schemas = {
  remember: z.object({ key: z.enum(MEMORY_KEYS), value: z.string().max(320), sessionId: z.string().min(1).max(200),
    derivedFrom: z.array(z.string().uuid()).max(100).optional(), agentClaim: z.string().max(500).optional() }).strict(),
  recall: z.object({ key: z.enum(MEMORY_KEYS).optional(), sessionId: z.string().min(1).max(200) }).strict(),
  list_memories: z.object({}).strict(),
  send_report: z.object({ recipients: z.array(z.string().max(320)).max(10), body: z.string().max(20000), sessionId: z.string().min(1).max(200) }).strict(),
  hook: z.object({ hook_event_name: z.enum(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]),
    session_id: z.string().min(1).max(200), prompt_id: z.string().optional(), prompt: z.string().max(100000).optional(),
    tool_name: z.string().optional(), tool_input: z.record(z.string(), z.unknown()).optional(), tool_response: z.unknown().optional(), tool_use_id: z.string().optional() }),
};

export function brokerServer(store: VaultStore, agentToken: string, hookToken: string) {
  if (agentToken.length < 32 || hookToken.length < 32 || agentToken === hookToken) throw new Error("Use distinct scoped tokens of at least 32 characters");
  return createServer(async (request, response) => {
    const finish = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(body));
    };
    try {
      const operation = request.url?.slice("/v1/".length) as keyof typeof schemas;
      if (request.method !== "POST" || !request.url?.startsWith("/v1/") || !Object.hasOwn(schemas, operation)) { finish(404, { error: "Unknown operation" }); return; }
      const supplied = request.headers.authorization?.replace(/^Bearer /u, "") ?? "";
      if (!tokenMatches(supplied, operation === "hook" ? hookToken : agentToken)) { finish(401, { error: "Unauthorized" }); return; }
      let raw = "";
      for await (const chunk of request) { raw += chunk; if (Buffer.byteLength(raw) > 200000) { finish(413, { error: "Input too large" }); return; } }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { finish(400, { error: "Invalid JSON" }); return; }
      const result = schemas[operation].safeParse(parsed);
      if (!result.success) { finish(400, { error: "Invalid input" }); return; }
      const input = result.data as any;
      const output = operation === "hook" ? await processHook(input as HookInput, store)
        : operation === "remember" ? await store.remember(input)
        : operation === "recall" ? await store.recall(input.key, input.sessionId)
        : operation === "list_memories" ? await store.allMemories()
        : await store.sendReport(input);
      finish(200, output);
    } catch { finish(503, { error: "Operation failed" }); }
  });
}

// Import-safe for network-boundary tests.
if (process.argv[1]?.endsWith("broker.ts")) {
  const config = loadConfig();
  if (config.mode !== "protected") throw new Error("The trusted broker only supports protected mode");
  brokerServer(new VaultStore(config), process.env.MEMORYVAULT_AGENT_TOKEN ?? "", process.env.MEMORYVAULT_HOOK_TOKEN ?? "")
    .listen(Number(process.env.MEMORYVAULT_BROKER_PORT ?? 8788), process.env.MEMORYVAULT_BROKER_HOST ?? "127.0.0.1");
}
