# MemoryVault

MemoryVault adds provenance, review, and containment controls to persistent AI-agent memory. It helps stop instructions from an external document from becoming trusted preferences that affect later sessions.

An example attack hides an external report recipient in a document. MemoryVault quarantines the proposed memory, records its source, and checks outgoing report recipients independently. A reviewer can inspect the memory's lineage, see which sessions and actions used it, and revoke it together with its descendants.

`send_report` simulates delivery and records an Outbox receipt. It does not send real email. The evaluation runner measures deterministic policy behavior, not live-model attack uptake.

## Architecture

```text
Claude Code → MCP adapter → trusted broker → write/tool gates → Supabase
Trusted hooks → broker → provenance ledger and session recall
Human dashboard → Supabase Auth/RLS → review, inspection, and revocation
```

- **Write gate:** validates typed values and checks independently recorded provenance. Quoted and embedded instructions stay untrusted; ambiguous requests require human review. Declared summaries inherit parent trust.
- **Tool gate:** checks each recipient against the configured owner's address and active, authorized recipient memories.
- **Broker:** holds database service credentials and exposes separate capabilities for agent operations and trusted hooks. Agent clients refuse inherited database service keys.
- **Dashboard:** provides authenticated approval/rejection, source and lineage inspection, usage timelines, cascading revocation, and read-only email-based sharing of selected active memories.
- **Database:** enforces ownership through RLS, active-parent constraints, immutable memory content/provenance, and transactional descendant revocation.

Memory keys: `report_recipients`, `cc`, `report_format`, `writing_tone`, `timezone`, `project_context`, and `personal_preference`. Only the recipient keys can authorize additional report recipients. Sharing a memory with a reader does not grant permission to send that reader reports.

## Development setup

Requires Node.js 22+ and a Supabase database with Auth enabled. Install dependencies:

```bash
npm ci
```

Apply every migration in `supabase/migrations/` in order to a development database. If using the Supabase CLI with a hosted project:

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
```

Configure a verified Auth user as the owner. The existing hosted/local bootstrap scripts create development users and write a combined `.env.local`; run those only in a trusted setup environment, then separate the credentials below. Do not load that combined environment into Claude Code.

| Process | Template | Credentials |
|---|---|---|
| Trusted broker | `example.server.env` | Supabase service key, owner identity, two distinct scoped tokens |
| MCP adapter | `example.agent.env` | Broker URL and agent token |
| Trusted hook runner | `example.hook.env` | Broker URL and hook token |
| Dashboard | `example.env` | Supabase URL, publishable key, owner ID |

Generate two distinct random tokens of at least 32 characters and configure them in the broker and corresponding adapters. Start the broker in its trusted service environment:

```bash
node --env-file=/absolute/private/path/server.env --import tsx src/broker.ts
```

For local development, copy the agent and hook templates into ignored `.env.agent` and `.env.hook` files and fill them in. The project MCP/hook configurations load those files. The optional explicit configurations in `demo/` use the same files:

```bash
claude --settings demo/claude-hooks.settings.json --strict-mcp-config --mcp-config demo/protected-mcp.json
```

The broker must be running first. The local hooks and MCP configuration apply after Claude Code trusts/enables the project configuration; hooks do not enforce a boundary against an unrestricted agent that can alter their code or read their credentials.

Configure the dashboard environment from `example.env`, then start it:

```bash
node --env-file=/absolute/private/path/dashboard.env --import tsx src/dashboard.ts
```

The default dashboard address is `http://127.0.0.1:8787`. Sign in using the configured owner's Supabase Auth credentials. `npm run dashboard` is a local convenience for a dashboard `.env.local`; it does not configure the broker.

See [PORTFOLIO_SETUP.md](PORTFOLIO_SETUP.md) for deployment boundaries and containment behavior. For production, isolate the broker and trusted hook collector from the agent's filesystem, process environment, and credentials. Two processes running as the same unrestricted OS user do not provide that isolation.

## Dashboard deployment

The Dockerfile starts the dashboard using environment variables; no `.env.local` is required inside the image. Supply `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `MEMORYVAULT_USER_ID`. For email sign-in and invitations, also set `MEMORYVAULT_PUBLIC_URL` to the dashboard's public HTTPS URL and add it to Supabase Auth's redirect allow list. Email delivery depends on the project's Auth configuration.

The dashboard does not need a service key. The Dockerfile deploys only the dashboard; the trusted broker and hook collector require separate isolation and configuration.

## Tests and evaluation

```bash
npm run typecheck
npm test
```

The suite covers authorization rules, broker capability boundaries, usage logging, context-limit exclusions, and all migrations in disposable PostgreSQL. Hosted integration tests are skipped unless development credentials are provided.

For a dedicated test database, the hosted integration tests and policy replay can be run from a trusted environment:

```bash
node --env-file=/absolute/private/path/test.env --import tsx --test src/integration.test.ts
node --env-file=/absolute/private/path/test.env --import tsx src/eval.ts --runs=10
```

These commands write database rows and can replace active preferences. Use a disposable development account/database, not a production vault. The test environment needs the broker's database/owner settings; human approval cases also need `SUPABASE_PUBLISHABLE_KEY` and `MEMORYVAULT_DEMO_PASSWORD` for the test user's password. The vulnerable baseline remains confined to the evaluation runner and its separate database table; it is not an agent deployment mode.

For an optional poisoned-document fixture, install `pdflatex` and `pdftotext`, then run `bash scripts/build_demo_fixture.sh`. Generated PDF/LaTeX files are ignored by Git.

## Limits and roadmap

This implementation has one configured broker owner and one simulated action tool. It has no semantic LLM content checker or live-model attack benchmark. Lineage depends on declared parent IDs. Revocation prevents future recall/authorization but cannot erase a running agent's existing context or undo a past delivery. Start a new session after containment.

Next steps are tracked in [docs/ROADMAP.md](docs/ROADMAP.md). The original [Track 3 brief](docs/archive/track-3-secure-attack-defend-the-agent.md) is retained only as historical context.
