import { VaultClient } from "./vault-client.js";
let raw = "";
for await (const chunk of process.stdin) {
  raw += chunk;
  if (raw.length > 200000) throw new Error("hook input too large");
}
try {
  const result = await new VaultClient("hook").call("hook", JSON.parse(raw));
  if (Object.keys(result).length) process.stdout.write(JSON.stringify(result) + "\n");
} catch {
  process.stderr.write("MemoryVault hook failed; trusted broker unavailable or rejected request.\n");
  process.exitCode = 2;
}
