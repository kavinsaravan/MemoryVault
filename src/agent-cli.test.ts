import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";

// Exercise the actual CLI and LangChain provider serialization without provider
// credentials, network services, or database writes.
test("agent CLI sends a tool-capable provider request without deprecated sampling parameters", async () => {
  const requests: Record<string, unknown>[] = [];
  const hooks: string[] = [];
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/hook") {
      hooks.push(String(body.hook_event_name));
      response.end(JSON.stringify({}));
    } else if (request.url?.startsWith("/v1/messages")) {
      requests.push(body);
      response.end(JSON.stringify({ id: "msg_test", type: "message", role: "assistant", model: "test-model", content: [{ type: "text", text: "Synthetic report prepared." }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
    } else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(SUPABASE_|MEMORYVAULT_|ANTHROPIC_|LANGCHAIN_|LANGSMITH_)/u.test(name)) delete env[name];
  Object.assign(env, {
    ANTHROPIC_API_KEY: "test-only-provider-key", ANTHROPIC_BASE_URL: base,
    MEMORYVAULT_MODEL: "test-model", MEMORYVAULT_USER_EMAIL: "owner@example.com",
    MEMORYVAULT_BROKER_URL: base, MEMORYVAULT_AGENT_TOKEN: "a".repeat(32), MEMORYVAULT_HOOK_TOKEN: "h".repeat(32),
  });
  const child = spawn(process.execPath, ["--import", "tsx", new URL("./agent-cli.ts", import.meta.url).pathname, "--task", "Prepare a synthetic report."], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
  try {
    const [code] = await once(child, "exit");
    assert.equal(code, 0, stderr);
    assert.match(JSON.stringify(JSON.parse(stdout).answer), /Synthetic report prepared/u);
    assert.deepEqual(hooks, ["UserPromptSubmit", "SessionStart"]);
    assert.equal(requests.length, 1);
    const request = requests[0]!;
    assert.equal(request.model, "test-model");
    assert.equal(request.max_tokens, 4096);
    assert.equal(Object.hasOwn(request, "temperature"), false);
    assert.deepEqual((request.tools as { name: string }[]).map(t => t.name), ["read_document", "recall", "remember", "send_report"]);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
