import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { ChatAnthropic } from "@langchain/anthropic";
import { createResearchAgent, type ResearchDocument } from "./agent.js";
import { VaultClient } from "./vault-client.js";

export async function loadDocument(path: string, id: string): Promise<ResearchDocument> {
  const handle = await open(resolve(path), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 50000) throw new Error("Documents must be regular UTF-8 text files of at most 50 KB");
    const buffer = Buffer.alloc(50001);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 50000) throw new Error("Document exceeds 50 KB");
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    if (content.includes("\0")) throw new Error("Binary documents are unsupported; supply text or Markdown");
    return { id, content };
  } finally { await handle.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log('Usage: npm run agent -- --task "Research and prepare a report" [--document ./brief.md ...]');
    console.log("Requires ANTHROPIC_API_KEY, MEMORYVAULT_MODEL, MEMORYVAULT_USER_EMAIL, broker URL, agent token and hook token. Do not load database service credentials.");
    return;
  }
  let task: string | undefined;
  const paths: string[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--task" && task === undefined) task = value;
    else if (flag === "--document") paths.push(value);
    else throw new Error(`Unknown or repeated argument: ${flag}`);
  }
  if (!task) throw new Error("--task is required; use --help for usage");
  if (paths.length > 20) throw new Error("At most 20 documents are supported");
  // Credential checks precede document reads and any provider call.
  const agentClient = new VaultClient("agent");
  const hookClient = new VaultClient("hook");
  for (const name of ["ANTHROPIC_API_KEY", "MEMORYVAULT_MODEL", "MEMORYVAULT_USER_EMAIL", "MEMORYVAULT_BROKER_URL", "MEMORYVAULT_AGENT_TOKEN", "MEMORYVAULT_HOOK_TOKEN"]) {
    if (!process.env[name]) throw new Error(`${name} is required`);
  }
  const documents: ResearchDocument[] = [];
  for (const [index, path] of paths.entries()) documents.push(await loadDocument(path, `document-${index + 1}`));
  const agent = createResearchAgent({
    model: new ChatAnthropic({ model: process.env.MEMORYVAULT_MODEL!, maxTokens: 4096, maxRetries: 1, clientOptions: { timeout: 60000 } }),
    agentClient, hookClient, documents, ownerEmail: process.env.MEMORYVAULT_USER_EMAIL!,
  });
  console.log(JSON.stringify(await agent.run(task), null, 2));
}

if (process.argv[1]?.endsWith("agent-cli.ts")) {
  main().catch(error => {
    // Provider errors may echo request details; expose only known local validation messages.
    const message = error instanceof Error ? error.message : "";
    const safe = /^(?:--task|Missing value|Unknown or repeated argument|At most|Documents must|Document exceeds|Binary documents|[A-Z_]+ is required|Refusing database credentials|Broker |Agent .*budget exceeded)/u.test(message);
    console.error(safe ? message : "Agent run failed. Check provider configuration, document paths and the trusted broker. Earlier tool actions may already be recorded; this run is not transactional.");
    process.exitCode = 1;
  });
}
