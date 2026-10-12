export function pastedSpans(prompt: string): string[] {
  return [...prompt.matchAll(/<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content>/giu)].map(match => match[1] ?? "");
}

export function isUntrustedRead(toolName: string): boolean {
  if (toolName.startsWith("mcp__memoryvault__") || toolName.startsWith("mcp__memoryvault_baseline__")) return false;
  return ["Read", "WebFetch", "WebSearch", "Bash"].includes(toolName) || toolName.startsWith("mcp__");
}

function memoryPath(value: string): boolean {
  return /(^|[/\\])CLAUDE\.md($|[/\\])|(^|[/\\])\.claude([/\\]|$)|(^|[/\\])\.codex([/\\]|$)|(^|[/\\])memory([/\\]|$)/iu.test(value);
}

export function isMemorySideDoor(toolName: string, input: Record<string, unknown>): boolean {
  if (["Write", "Edit", "MultiEdit"].includes(toolName)) {
    return memoryPath(String(input.file_path ?? input.path ?? ""));
  }
  if (toolName === "Bash") {
    const command = String(input.command ?? "");
    return memoryPath(command) && /(?:>|tee\b|cp\b|mv\b|sed\b|python\b|node\b|cat\b|touch\b)/iu.test(command);
  }
  return false;
}

export function sourceRef(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "Read") return `document:${String(input.file_path ?? input.path ?? "unknown")}`;
  return `${toolName}:${String(input.url ?? input.command ?? "").slice(0, 180)}`;
}

/**
 * Once a session has read anything untrusted, every later write to persistent agent
 * instructions is suspect, even in a later turn: a user asking to "remember that doc"
 * has not necessarily seen the instruction hidden in it.
 */
export function sessionTaintsMemoryWrites(sessionEvents: readonly { kind: string }[]): boolean {
  return sessionEvents.some(event => event.kind === "untrusted_read");
}
