// Agent-side adapters never import VaultStore or load database credentials.
export class VaultClient {
  constructor(readonly role: "agent" | "hook") {
    if (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error("Refusing database credentials in an agent-side process");
    }
  }
  async call(operation: string, input: unknown): Promise<any> {
    const base = process.env.MEMORYVAULT_BROKER_URL;
    const token = process.env[this.role === "hook" ? "MEMORYVAULT_HOOK_TOKEN" : "MEMORYVAULT_AGENT_TOKEN"];
    if (!base || !token) throw new Error("Broker URL and scoped token are required");
    const url = new URL(base);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
      throw new Error("Broker must use HTTPS outside localhost");
    }
    const response = await fetch(new URL(`/v1/${operation}`, url), {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(input), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`Broker rejected request (${response.status})`);
    return response.json();
  }
}
