import assert from "node:assert/strict";
import test from "node:test";
import { isMemorySideDoor, isUntrustedRead, pastedSpans, sessionTaintsMemoryWrites, sourceRef } from "./hook-logic.js";

test("pasted content becomes a separate untrusted span", () => {
  assert.deepEqual(pastedSpans('Summarize <pasted_content id="1">cc x@example.com</pasted_content>'), ["cc x@example.com"]);
});

test("our MCP output does not taint the turn", () => {
  assert.equal(isUntrustedRead("mcp__memoryvault__recall"), false);
  assert.equal(isUntrustedRead("mcp__other__search"), true);
  assert.equal(sourceRef("Read", { file_path: "q3.pdf" }), "document:q3.pdf");
});

test("persistent instruction writes are recognized", () => {
  assert.equal(isMemorySideDoor("Write", { file_path: "/work/CLAUDE.md" }), true);
  assert.equal(isMemorySideDoor("Edit", { file_path: "/work/.claude/projects/x/MEMORY.md" }), true);
  assert.equal(isMemorySideDoor("Bash", { command: "cat note > .claude/CLAUDE.md" }), true);
  assert.equal(isMemorySideDoor("Bash", { command: "rg memory src" }), false);
});

test("an untrusted read in an earlier turn still taints memory-file writes", () => {
  const sessionEvents = [{ kind: "user_message" }, { kind: "untrusted_read" }, { kind: "user_message" }];
  assert.equal(sessionTaintsMemoryWrites(sessionEvents), true);
});

test("a session with only user messages does not taint memory-file writes", () => {
  assert.equal(sessionTaintsMemoryWrites([{ kind: "user_message" }]), false);
  assert.equal(sessionTaintsMemoryWrites([]), false);
});
