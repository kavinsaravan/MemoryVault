import { createHash } from "node:crypto";

export const MEMORY_KEYS = ["report_recipients", "cc", "report_format", "writing_tone", "timezone", "project_context", "personal_preference"] as const;
export type MemoryKey = typeof MEMORY_KEYS[number];
export type Origin = "user_message" | "document" | "tool_output" | "model_summary";
export type Status = "active" | "quarantined" | "rejected" | "revoked";
export type RuleStep = { rule: string; matched: boolean; evidence?: string };
export type LedgerSpan = { id: string; kind: "user_message" | "untrusted_read"; content: string; source_ref?: string | null };
export type ParentMemory = { id: string; status: Status; user_id: string };

export type WriteDecision = {
  key: MemoryKey | string;
  value: string;
  status: Status;
  origin: Origin;
  originRef: string | null;
  rule: string;
  steps: RuleStep[];
};

const EMAIL = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/u;
const FORMATS = new Set(["bullets", "paragraphs", "table"]);
const TONES = new Set(["concise", "formal", "friendly", "technical"]);

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function validMemoryValue(key: string, value: string): boolean {
  if (value.length === 0 || value.length > 320) return false;
  if (key === "report_recipients" || key === "cc") return EMAIL.test(value.trim());
  if (key === "report_format") return FORMATS.has(value.trim().toLowerCase());
  if (key === "writing_tone") return TONES.has(value.trim().toLowerCase());
  if (key === "timezone") {
    try { new Intl.DateTimeFormat("en", { timeZone: value.trim() }); return true; } catch { return false; }
  }
  if (key === "project_context" || key === "personal_preference") return !/[\x00-\x1f\x7f]/u.test(value) && value.trim().length > 0;
  return false;
}

export function authoredPrompt(prompt: string): string {
  return prompt
    .replace(/<pasted_content\b[^>]*>[\s\S]*?(?:<\/pasted_content>|$)/giu, " ")
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/gu, " ")
    .replace(/^\s*>.*$/gmu, " ")
    .replace(/"[^"]*(?:"|$)|“[^”]*(?:”|$)|`[^`]*(?:`|$)/gmu, " ")
    .replace(/(?:^|\s)'[^']*(?:'|$)|‘[^’]*(?:’|$)/gmu, " ");
}

function normalized(input: string): string {
  return input.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function decodedVariants(input: string): string[] {
  const variants = [input];
  try { variants.push(decodeURIComponent(input)); } catch { /* invalid encoding */ }
  for (const token of input.match(/[A-Za-z0-9+/=]{16,}/gu) ?? []) {
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      if (/^[\x20-\x7e]+$/u.test(decoded)) variants.push(decoded);
    } catch { /* malformed base64 */ }
  }
  return variants;
}

function overlaps(value: string, content: string): boolean {
  const needle = normalized(value);
  if (!needle) return false;
  for (const variant of decodedVariants(content)) {
    const haystack = normalized(variant);
    if (haystack.includes(needle)) return true;
    // Modest n-gram check for spacing or punctuation changes around longer values.
    if (needle.length >= 12) {
      const compactNeedle = needle.replace(/[^a-z0-9]/gu, "");
      const compactHaystack = haystack.replace(/[^a-z0-9]/gu, "");
      if (compactNeedle.length >= 8 && compactHaystack.includes(compactNeedle)) return true;
    }
  }
  return false;
}

function userAuthorizes(key: string, value: string, prompt: string): boolean {
  const authored = normalized(authoredPrompt(prompt));
  // Requests to inspect external content are ambiguous even without delimiters.
  if (/\b(?:summarize|analyse|analyze|translate|quote|review|explain)\b/iu.test(authored)) return false;
  const target = normalized(value);
  const index = authored.lastIndexOf(target);
  if (index < 0) return false;
  const clause = authored.slice(Math.max(0, authored.lastIndexOf(".", index) + 1), index + target.length);
  if (/\b(?:do not|don't|never|stop|remove|exclude|without|not to)\b/iu.test(clause)) return false;
  // Authority must begin as a direct request, not arbitrary reported speech.
  const prefix = clause.slice(0, -target.length).trim();
  if (!/^(?:(?:please|always|from now on[, ]*|for (?:future|all) reports[, ]*)\s*)*(?:i\s+)?(?:cc|send|add|include|copy|use|format|prefer|set|remember|save)\b/iu.test(prefix)) return false;
  if (key === "cc" || key === "report_recipients") {
    return /\b(?:cc|send|add|include|copy)\b[^.]{0,100}$/iu.test(clause.slice(0, -target.length));
  }
  if (key === "report_format") return /\b(?:use|format|prefer|set)\b[^.]{0,100}$/iu.test(clause.slice(0, -target.length));
  if (key === "writing_tone" || key === "timezone") return /\b(?:use|prefer|set|remember)\b[^.]{0,100}$/iu.test(clause.slice(0, -target.length));
  if (key === "project_context" || key === "personal_preference") return /\b(?:remember|save)\b[^.]{0,100}$/iu.test(clause.slice(0, -target.length));
  return false;
}

/**
 * Untrusted reads taint the whole session, not just the turn they happened in; a user
 * message only counts as authorization if it is the latest one. Events must be chronological.
 */
export function ledgerForWrite(sessionEvents: LedgerSpan[]): LedgerSpan[] {
  const latestPromptIndex = sessionEvents.findLastIndex(event => event.kind === "user_message");
  return sessionEvents.filter((event, index) => event.kind === "untrusted_read" || (latestPromptIndex >= 0 && index >= latestPromptIndex));
}

export function evaluateWrite(input: {
  key: string;
  value: string;
  ledger: LedgerSpan[];
  parents?: ParentMemory[];
  userId: string;
}): WriteDecision {
  const value = input.value.trim();
  const steps: RuleStep[] = [];
  if (!validMemoryValue(input.key, value)) {
    steps.push({ rule: "WG-04", matched: true, evidence: "key or value failed its validator" });
    return { key: input.key, value, status: "rejected", origin: "tool_output", originRef: null, rule: "WG-04", steps };
  }
  steps.push({ rule: "WG-04", matched: false });

  const latestPrompt = [...input.ledger].reverse().find(event => event.kind === "user_message");
  if (latestPrompt && overlaps(value, latestPrompt.content) && !overlaps(value, authoredPrompt(latestPrompt.content))) {
    steps.push({ rule: "WG-02", matched: true, evidence: "quoted or embedded user-message content" });
    return { key: input.key, value, status: "quarantined", origin: "document", originRef: latestPrompt.id, rule: "WG-02", steps };
  }
  const untrusted = input.ledger.filter(event => event.kind === "untrusted_read");
  const matchedRead = untrusted.find(event => overlaps(value, event.content));
  if (matchedRead) {
    const origin: Origin = matchedRead.source_ref?.startsWith("document:") ? "document" : "tool_output";
    steps.push({ rule: "WG-02", matched: true, evidence: matchedRead.source_ref ?? matchedRead.id });
    return { key: input.key, value, status: "quarantined", origin, originRef: matchedRead.id, rule: "WG-02", steps };
  }
  steps.push({ rule: "WG-02", matched: false });

  const latestUser = [...input.ledger].reverse().find(event => event.kind === "user_message");
  const userSaidValue = latestUser ? userAuthorizes(input.key, value, latestUser.content) : false;
  const parents = input.parents ?? [];
  if (parents.length > 0) {
    const allActive = parents.every(parent => parent.user_id === input.userId && parent.status === "active");
    steps.push({ rule: "WG-05", matched: !allActive, evidence: parents.map(parent => `${parent.id}:${parent.status}`).join(", ") });
    if (!allActive) return { key: input.key, value, status: "quarantined", origin: "model_summary", originRef: null, rule: "WG-05", steps };
  }
  if (untrusted.length > 0 && !userSaidValue) {
    steps.push({ rule: "WG-03", matched: true, evidence: "untrusted read earlier in this session" });
    return { key: input.key, value, status: "quarantined", origin: parents.length ? "model_summary" : "tool_output", originRef: untrusted.at(-1)?.id ?? null, rule: "WG-03", steps };
  }
  steps.push({ rule: "WG-03", matched: false });
  if (userSaidValue) {
    steps.push({ rule: "WG-01", matched: true, evidence: latestUser?.id });
    return { key: input.key, value, status: "active", origin: "user_message", originRef: latestUser?.id ?? null, rule: "WG-01", steps };
  }
  if (parents.length > 0) {
    return { key: input.key, value, status: "active", origin: "model_summary", originRef: null, rule: "WG-05", steps };
  }
  steps.push({ rule: "WG-01", matched: false });
  return { key: input.key, value, status: "quarantined", origin: "tool_output", originRef: null, rule: "WG-03", steps };
}

export type RecipientMemory = {
  id: string;
  key: string;
  value: string;
  status: Status;
  origin: Origin;
  confirmed_by?: string | null;
};

export function evaluateShare(requested: string[], userAddress: string, memories: RecipientMemory[]) {
  const owner = userAddress.toLowerCase();
  const sent: string[] = [];
  const blocked: string[] = [];
  const usedMemoryIds: string[] = [];
  const steps: RuleStep[] = [];
  for (const raw of requested) {
    const address = raw.trim().toLowerCase();
    const memory = memories.find(item =>
      (item.key === "report_recipients" || item.key === "cc") &&
      item.value.toLowerCase() === address && item.status === "active"
    );
    if (EMAIL.test(address) && address === owner) {
      sent.push(address);
    } else if (!memory) {
      blocked.push(address);
      steps.push({ rule: "TG-01", matched: true, evidence: address });
    } else if (memory.origin !== "user_message" && !memory.confirmed_by) {
      blocked.push(address);
      steps.push({ rule: "TG-02", matched: true, evidence: memory.id });
    } else {
      sent.push(address);
      usedMemoryIds.push(memory.id);
    }
  }
  return {
    sentRecipients: [...new Set(sent)],
    blockedRecipients: [...new Set(blocked)],
    memoryIds: [...new Set(usedMemoryIds)],
    decision: blocked.length ? "blocked" as const : "allowed" as const,
    rule: steps[0]?.rule ?? "TG-01",
    steps,
  };
}
