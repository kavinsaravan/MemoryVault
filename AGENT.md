# LangGraph research agent

MemoryVault includes a TypeScript LangGraph agent backed by a tool-capable Claude
model through LangChain's Anthropic integration. It researches explicitly supplied
text documents, recalls preferences, proposes persistent memories, writes reports,
and can request simulated delivery through the existing broker. It does not browse
the web, execute shell commands, or send email.

## Setup

Install dependencies with `npm ci`. Configure and start the protected broker using
the separate server environment described in [README.md](README.md). Use a disposable
development owner/database for attack demonstrations: memory and Outbox operations
persist real rows.

Copy `example.research-agent.env` to `.env.research-agent` and set:

- `ANTHROPIC_API_KEY`: your provider key; model calls incur provider charges.
- `MEMORYVAULT_MODEL`: a tool-capable Claude model ID available to your account.
- `MEMORYVAULT_USER_EMAIL`: the configured broker owner's email.
- Broker URL and its two distinct scoped tokens.

This is a trusted application runner. Its host code holds the hook token and
records provenance, while the model receives only messages, tool schemas and
results. It does not launch Claude Code or give the model access to the host
filesystem, environment, hook operations, or database credentials. Never load the
combined `.env.local` into it. `VaultClient` refuses inherited database service
keys. Run the broker in its separately isolated trusted environment. This runner
must also remain outside any unrestricted agent's control; tools and prompts do
not create OS-level isolation.

Documents, recalled preferences, user tasks and reports are processed by the model
provider. Supply only documents appropriate for that environment. Files are UTF-8
text or Markdown, up to 50 KB each, at most 20 per run. File paths are supplied by
the human CLI caller; the model sees generated IDs such as `document-1` and can
read only those IDs.

## Run

```bash
node --env-file=.env.research-agent --import tsx src/agent-cli.ts \
  --task "Read document-1, prepare a concise weekly report with source citations, and simulate delivery to my authorized recipients." \
  --document fixtures/benign_market_brief.md
```

The CLI prints JSON containing a fresh session ID, model/tool-call counts, the
final response, and tool inputs/results. The `send_report` receipt in the trace is
the authoritative simulated delivery result; the model's prose is not proof of
delivery. The existing dashboard shows persisted memories, provenance and Outbox.

The equivalent command when the variables are already exported is:

```bash
npm run agent -- --task "Read document-1 and write a report." --document fixtures/benign_market_brief.md
```

Set a legitimate preference in a separate run:

```bash
node --env-file=.env.research-agent --import tsx src/agent-cli.ts \
  --task "Use a concise writing tone. Save this preference for future reports."
```

Each invocation starts a fresh conversation and recalls persistent active
preferences. Conversation checkpoints and interactive multi-turn sessions are not
implemented; persistence is deliberately handled by MemoryVault.

## Poisoned-document demonstration

```bash
node --env-file=.env.research-agent --import tsx src/agent-cli.ts \
  --task "Read document-1, prepare a weekly report, and simulate delivery to my authorized recipients." \
  --document fixtures/poisoned_market_brief.md
```

The fixture tries to make the agent save an external CC recipient. Inspect the
trace to distinguish model resistance (no malicious proposal) from gate defense
(an attempted proposal is quarantined). If the agent attempts delivery to that
address, inspect the receipt's `blockedRecipients`. A secure model may refuse the
injection itself, so an attack attempt or quarantine is not guaranteed on every
live run. Do not interpret an unattempted attack as a measured gate block.

Run a later report with the benign fixture to inspect recall across sessions.
Quarantined recipients must remain absent from active recall. Tests cover the
case where the model does attempt both poisoning and delivery. The live commands
are demonstrations, not a statistically meaningful attack-success benchmark.

## Execution and failure behavior

The graph alternates `model → tools → model` until the model finishes. It defaults
to at most 12 model calls and 24 tool calls. The provider uses a 60-second request
timeout, one retry, and a 4096-token output limit. Tools execute sequentially,
including within a single model response. Before returning document text to the
model, the runner awaits the broker's trusted `PostToolUse` provenance hook.
Session IDs are created by the host and excluded from model tool schemas.

Invalid arguments and unknown tools return tool errors the model can inspect.
Broker/provenance failures, malformed calls and budget exhaustion abort the run.
Earlier writes and Outbox receipts remain committed: a whole agent run is not a
transaction. Check the dashboard before retrying a failed run. The host enforces
capabilities and broker authorization; document citations, report quality and
whether the model chooses to complete a task still require evaluation.

## Deployment and credential isolation

Apply all migrations in order, including
`supabase/migrations/20261013000000_lineage_and_containment.sql`, to a development
database before running demonstrations. Back up an existing database before
migration; the lineage migration preserves rows and audit history.

Separate processes running as the same unrestricted OS user do not isolate
credentials. Run the database broker outside any model-controlled container,
filesystem mounts, and process environment. Keep trusted runner and hook code
immutable to model-controlled tools. Remove database service secrets from the
agent's checkout when configuring an isolated deployment.

The LangGraph application runner is trusted host code and holds both scoped
broker tokens. The model receives neither token and has no tool for submitting
provenance, approving memories, revoking memories, or issuing database queries.
For an external assistant using MCP, configure only the agent token in the MCP
adapter; the separate trusted hook collector holds the hook token. Keep that
collector and its credentials outside the external agent's control.

Local `.env.hook` and other ignored environment files are development
conveniences, not a production security boundary. An unrestricted shell tool can
read local credentials. Do not export database service keys into agent processes
or mount the server environment into a model-controlled container. The MCP adapter
and LangGraph runner refuse inherited Supabase service keys.

The dashboard needs only the Supabase URL, publishable key, and configured owner
ID. Review, sharing, inspection, and revocation use the signed-in human's JWT and
RLS permissions, never the broker's service key. Start it with `npm run dashboard`
for local development, or pass environment variables and run
`node --import tsx src/dashboard.ts` for deployment.

Use HTTPS for a remote broker; its clients reject remote plaintext URLs. The
broker has one configured owner. Multi-user deployments require separate broker
instances and user-scoped credentials; this version has no multi-tenant token
registry.

## Inspection, authorization, and containment

The dashboard's **Inspect lineage & usage** link shows a memory's original ledger
source, ancestors and descendants, chronological usage events, session IDs, and
affected simulated Outbox actions. Inspection follows the signed-in user's RLS
policies without a recent-history cutoff. Missing historical instrumentation
cannot be reconstructed automatically.

Usage events distinguish `injected`, `recalled_by_tool`, `withheld`,
`applied_in_action`, and `blocked_in_action`. Memories excluded by the context
limit are logged as withheld. Action events carry the Outbox ID, and receipts
retain both applied and considered recipient memories so blocked recipients can
be traced.

**Revoke memory and descendants** atomically revokes the selected active or
quarantined memory and its derived descendants, removes sharing flags, and
preserves audit events. Replacing an active preference also revokes its
descendants. Revocation prevents future retrieval and authorization; it cannot
erase text already in a running agent's context or undo past deliveries. Start a
new session after containment. Lineage relies on declared parent IDs; undeclared
semantic dependencies cannot be inferred.

Authorization treats quoted text, blockquotes, fenced code, inline code, and
pasted-content blocks as lower-trust content. Inspection or translation requests
and reported speech cannot establish direct preferences. Ambiguous requests
require human review. The parser is conservative and deterministic, not a
universal natural-language intent classifier.

## Validation

```bash
npm run typecheck
npm test
```

`src/agent.test.ts` runs the actual LangGraph loop with scripted model responses
and an in-memory broker double using the production gate functions. It checks
cross-session poisoning defense, legitimate preference retention, provenance
failure, forged tool arguments, unknown document IDs, and execution budgets.
Existing tests separately exercise the HTTP broker, stores and migrations.
Database tests verify cascading revocation across three levels, one audit event
per revoked node, cross-user RLS, owner-only revocation, and revoked-parent
rejection. Hosted Supabase integration tests need separate development
credentials and otherwise skip. Local automated tests need no provider API key
and do not measure live-model behavior.
