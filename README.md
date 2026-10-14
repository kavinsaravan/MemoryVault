> Portfolio update: see [PORTFOLIO_SETUP.md](PORTFOLIO_SETUP.md) for the trusted broker configuration, lineage inspector, and cascading revocation. The older hackathon commands below assume direct database access and are superseded for agent-side MCP/hooks.

# MemoryVault

MemoryVault demonstrates a persistent-memory prompt injection defense for the CrowdStrike Hackathon Track 3 brief. A poisoned document tries to save an unauthorized report recipient. The protected path quarantines that memory, and a separate tool gate checks every simulated `send_report` recipient. The Outbox is stored in Supabase Postgres; no email is sent.

## Build phases

1. **Data and rules:** Supabase migration, provenance ledger, deterministic write and tool gates, and a separate vulnerable baseline table.
2. **Agent integration:** one stdio MCP server and Claude Code hooks for prompts, document/tool reads, session recall, and memory-file writes.
3. **Review and replay:** authenticated approval dashboard, synthetic PDF fixture, and a repeated policy replay harness.

The code for these phases is present. The replay harness drives the gates directly; a repeated live Claude Code attack run and backup demo video remain to be done.

## Setup (one shared hosted database)

Everyone uses the same hosted Supabase project, so there is no local database. Requires Node 22+ and (for the PDF fixture) `pdflatex` and `pdftotext`.

First person only, once:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
npm install
npm run setup -- --project-ref YOUR_PROJECT_REF --owner-email YOU@EXAMPLE.COM
bash scripts/build_demo_fixture.sh
```

`npm run setup` checks the schema, creates a demo Auth user, and writes the URL, keys, user ID, and generated password to `.env.local` (mode `0600`, ignored by Git). Teammates run `npm install` and get `.env.local` from whoever ran setup. Keep the secret key in server and hook processes only.

```bash
npm run typecheck
npm test
node --env-file=.env.local --import tsx --test src/integration.test.ts
node --env-file=.env.local --import tsx src/eval.ts --runs=10
npm run dashboard
```

The dashboard listens on `http://127.0.0.1:8787`. Sign in as `demo-user@company.example` with `MEMORYVAULT_DEMO_PASSWORD` from `.env.local`. It shows pending and active memories, source evidence, rule traces, and sharing activity. Approval and rejection call Auth protected database functions; the MCP server has no approval tool.

Supported memory keys are `report_recipients`, `cc`, `report_format`, `writing_tone`, `timezone`, `project_context`, and `personal_preference`. Free-text project and personal memories require an explicit user request to remember the exact value; document-derived memories remain quarantined. Only the two recipient keys can authorize an additional report recipient.

`send_report` is a **simulation**. It checks report recipients and records the allowed and blocked addresses in Supabase `share_attempts`; it does not send email or share a file. Memory sharing is a separate feature: the owner marks active memories **Shared**, grants an email access, and the signed-in recipient gets a read-only view of all memories the owner marked Shared. Revoking the email grant or making a memory private removes it from that view immediately. Quarantined memories cannot be shared.

## Share the dashboard

For email recipients on other computers, deploy the included `Dockerfile` to a public HTTPS host. Set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `MEMORYVAULT_USER_ID`, and `MEMORYVAULT_PUBLIC_URL=https://YOUR_DASHBOARD_URL` in the host's secret/environment settings. The dashboard does not need the secret key when deployed; sharing changes use the signed-in owner's Auth token. Add that HTTPS URL to the Supabase Auth redirect allow list. The owner can then enter a recipient email in **Share with people**. Supabase sends a sign-in link, and the recipient sees the active memories marked Shared. Email delivery depends on the hosted project's Auth email configuration and limits. Keep `MEMORYVAULT_PUBLIC_URL` unset for local dashboard preview; no recipient email is sent in that mode.

## Claude Code demo

MemoryVault is opt in. An ordinary `claude` session in this project does not load its hooks or MCP server. When you are ready to run the demo, launch Claude Code from this project root with the environment loaded and explicitly pass the [protected MCP configuration](demo/protected-mcp.json) and [hook settings](demo/claude-hooks.settings.json):

```bash
set -a
source .env.local
set +a
claude --settings demo/claude-hooks.settings.json --strict-mcp-config --mcp-config demo/protected-mcp.json
```

On the first interactive demo launch, Claude Code may ask you to approve the `memoryvault` server so its tools become available.

For a separate vulnerable session, launch with only the [baseline server](demo/baseline-mcp.json):

```bash
set -a
source .env.local
set +a
MEMORYVAULT_MODE=baseline claude --settings demo/claude-hooks.settings.json --strict-mcp-config --mcp-config demo/baseline-mcp.json
```

In session 1, ask the agent to summarize `fixtures/q3_market_brief.pdf`. In a fresh session, ask it to write and share the weekly report. Compare the real Outbox rows for the two modes. The address in the PDF is synthetic. The agent must actually propose the memory for the live attack to demonstrate uptake; the deterministic replay does not measure that behavior.

## Evidence and limits

`npm test` covers the gate rules and hook classifiers. The integration test checks the database constraint, the server role's inability to call approval, human approval through Supabase Auth, and preference replacement. The replay writes real Supabase rows for five attack forms, a tool-gate backstop case, and five benign cases, ten runs each by default.

This is a one-user, one-tool demo. Claude Code can run arbitrary local programs with the user's permissions, so the hook that guards `CLAUDE.md` and auto-memory files only covers recognizable `Write`/`Edit` paths and common Bash writes. The Supabase secret key is inherited by the local Claude Code process in this setup; a production deployment needs a separate gate service and credentials inaccessible to agent-executable tools. Treat the local results as evidence for this attack chain, not a general prompt injection guarantee.
