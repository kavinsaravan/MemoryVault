import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";
import { evaluateShare, evaluateWrite, ledgerForWrite, MEMORY_KEYS, sha256, type LedgerSpan, type ParentMemory, type RecipientMemory } from "./gates.js";

export class VaultStore {
  readonly db: SupabaseClient;
  constructor(readonly config: Config) {
    this.db = createClient(config.url, config.secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }

  private unwrap<T>(result: { data: T; error: { message: string } | null }): T {
    if (result.error) throw new Error(result.error.message);
    return result.data;
  }

  async ensureDocument(title: string, body: string): Promise<string> {
    const digest = sha256(body);
    const existing = this.unwrap(await this.db.from("documents").select("id")
      .eq("user_id", this.config.userId).eq("sha256", digest).limit(1));
    if (existing?.[0]?.id) return existing[0].id;
    const row = this.unwrap(await this.db.from("documents").insert({
      user_id: this.config.userId, title: title.slice(0, 300), body: body.slice(0, 20000), sha256: digest,
    }).select("id").single());
    if (!row) throw new Error("document insert returned no row");
    return row.id;
  }

  async recordLedger(event: { sessionId: string; promptId?: string; kind: "user_message" | "untrusted_read"; toolUseId?: string; sourceRef?: string; content: string }) {
    const content = event.content.slice(0, 20000);
    return this.unwrap(await this.db.from("ledger_events").insert({
      user_id: this.config.userId, session_id: event.sessionId, prompt_id: event.promptId,
      kind: event.kind, tool_use_id: event.toolUseId, source_ref: event.sourceRef,
      content, content_sha256: sha256(content),
    }).select().single());
  }

  async sessionEvents(sessionId: string): Promise<LedgerSpan[]> {
    const rows: LedgerSpan[] = [];
    // Do not silently drop an earlier taint when a session exceeds one page.
    for (let offset = 0; ; offset += 500) {
      const page = this.unwrap(await this.db.from("ledger_events").select("id,kind,content,source_ref,ts")
        .eq("user_id", this.config.userId).eq("session_id", sessionId)
        .order("ts", { ascending: true }).order("id", { ascending: true }).range(offset, offset + 499)) ?? [];
      rows.push(...page as LedgerSpan[]);
      if (page.length < 500) return rows;
    }
  }

  async sessionLedger(sessionId: string): Promise<{ kind: string }[]> {
    return this.unwrap(await this.db.from("ledger_events").select("kind")
      .eq("user_id", this.config.userId).eq("session_id", sessionId).eq("kind", "untrusted_read").limit(1)) ?? [];
  }

  async activeMemories(key?: string): Promise<RecipientMemory[]> {
    let query = this.db.from("memories").select("id,key,value,status,origin,confirmed_by")
      .eq("user_id", this.config.userId).eq("status", "active");
    if (key) query = query.eq("key", key);
    return (this.unwrap(await query) ?? []) as RecipientMemory[];
  }

  async allMemories() {
    return this.unwrap(await this.db.from("memories").select("id,key,value,status,origin,origin_ref,created_at,confirmed_by")
      .eq("user_id", this.config.userId).order("created_at", { ascending: false }).limit(100));
  }

  async remember(input: { key: string; value: string; sessionId: string; derivedFrom?: string[]; agentClaim?: string }) {
    if (this.config.mode === "baseline") {
      const row = this.unwrap(await this.db.from("demo_baseline_memories").insert({
        user_id: this.config.userId, key: input.key, value: input.value, session_id: input.sessionId,
      }).select().single());
      return { status: "active", rule: "BASELINE", memoryId: row.id, steps: [] };
    }
    const ledger = ledgerForWrite(await this.sessionEvents(input.sessionId));
    const ids = input.derivedFrom ?? [];
    const parentRows = ids.length ? this.unwrap(await this.db.from("memories").select("id,status,user_id")
      .eq("user_id", this.config.userId).in("id", ids)) : [];
    const parents = parentRows as ParentMemory[];
    const decision = evaluateWrite({ key: input.key, value: input.value, ledger, parents, userId: this.config.userId });
    // A missing parent is treated as untrusted; the model cannot invent lineage.
    if (ids.length !== parents.length && decision.status === "active") {
      decision.status = "quarantined";
      decision.rule = "WG-05";
      decision.steps.push({ rule: "WG-05", matched: true, evidence: "missing parent" });
    }
    let memoryId: string | null = null;
    if (MEMORY_KEYS.some(key => key === decision.key)) {
      const row = this.unwrap(await this.db.rpc("propose_memory", {
        p_user_id: this.config.userId, p_key: decision.key, p_value: decision.value,
        p_origin: decision.origin, p_origin_ref: decision.originRef, p_status: decision.status,
        p_derived_from: ids, p_session_id: input.sessionId, p_deciding_rule: decision.rule,
        p_steps: decision.steps, p_agent_claim: input.agentClaim?.slice(0, 500) ?? null,
      }));
      memoryId = row.id;
    } else {
      this.unwrap(await this.db.from("memory_events").insert({
        user_id: this.config.userId, session_id: input.sessionId, event: "rejected",
        deciding_rule: decision.rule, steps: decision.steps, agent_claim: input.agentClaim?.slice(0, 500) ?? null,
      }));
    }
    return { status: decision.status, rule: decision.rule, memoryId, steps: decision.steps };
  }

  async recall(key?: string, sessionId?: string, usage: "injected" | "recalled_by_tool" = "recalled_by_tool") {
    if (this.config.mode === "baseline") {
      let query = this.db.from("demo_baseline_memories").select("id,key,value,created_at")
        .eq("user_id", this.config.userId).order("created_at", { ascending: false }).limit(100);
      if (key) query = query.eq("key", key);
      return this.unwrap(await query) ?? [];
    }
    const candidates = this.unwrap(await this.db.from("memories").select("id,key,value,status,origin,confirmed_by")
      .eq("user_id", this.config.userId).in("status", ["active", "quarantined", "revoked"])
      .order("created_at", { ascending: true })) as RecipientMemory[];
    const matching = candidates.filter(memory => !key || memory.key === key);
    let remaining = 7500;
    const included: RecipientMemory[] = [];
    const events = matching.map(memory => {
      const length = `${memory.key}: ${memory.value}\n`.length;
      const include = memory.status === "active" && (usage !== "injected" || length <= remaining);
      if (include) { included.push(memory); remaining -= length; }
      return { user_id: this.config.userId, memory_id: memory.id, session_id: sessionId,
        event: include ? usage : "withheld", deciding_rule: include ? "RECALL-ACTIVE" : memory.status === "active" ? "CONTEXT-LIMIT" : "RECALL-UNTRUSTED" };
    });
    if (sessionId && events.length) this.unwrap(await this.db.from("memory_events").insert(events));
    return included;
  }

  async sendReport(input: { recipients: string[]; body: string; sessionId: string }) {
    // The body is intentionally not sent anywhere. The Outbox is the proof.
    let sentRecipients: string[];
    let blockedRecipients: string[];
    let memoryIds: string[] = [];
    let decision: "allowed" | "blocked";
    let rule: string;
    if (this.config.mode === "baseline") {
      sentRecipients = [...new Set(input.recipients.map(value => value.trim().toLowerCase()))];
      blockedRecipients = [];
      decision = "allowed";
      rule = "BASELINE";
    } else {
      const result = evaluateShare(input.recipients, this.config.userEmail, await this.activeMemories());
      ({ sentRecipients, blockedRecipients, memoryIds, decision, rule } = result);
    }
    const candidates = this.config.mode === "protected" ? this.unwrap(await this.db.from("memories")
      .select("id,key,value,status").eq("user_id", this.config.userId).in("key", ["cc", "report_recipients"])) ?? [] : [];
    const requested = new Set(input.recipients.map(value => value.trim().toLowerCase()));
    const considered = candidates.filter(memory => requested.has(memory.value.toLowerCase()));
    const row = this.unwrap(await this.db.from("share_attempts").insert({
      user_id: this.config.userId, session_id: input.sessionId,
      requested_recipients: input.recipients, sent_recipients: sentRecipients,
      blocked_recipients: blockedRecipients, decision, deciding_rule: rule,
      memory_ids: memoryIds, considered_memory_ids: considered.map(memory => memory.id), gates_enabled: this.config.mode === "protected",
    }).select().single());
    if (memoryIds.length) this.unwrap(await this.db.from("memory_events").insert(memoryIds.map(memoryId => ({
      user_id: this.config.userId, memory_id: memoryId, session_id: input.sessionId,
      event: "applied_in_action", deciding_rule: "TG-01", action_id: row.id,
    }))));
    const blockedMemories = considered.filter(memory => blockedRecipients.includes(memory.value.toLowerCase()));
    if (blockedMemories.length) this.unwrap(await this.db.from("memory_events").insert(blockedMemories.map(memory => ({
      user_id: this.config.userId, memory_id: memory.id, session_id: input.sessionId,
      event: "blocked_in_action", deciding_rule: rule, action_id: row.id,
    }))));
    return { outboxId: row.id, sentRecipients, blockedRecipients, decision, rule };
  }
}
