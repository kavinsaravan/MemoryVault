# Portfolio hardening and containment

This version adds conservative direct-user authorization, a separate trusted database broker, lineage and usage inspection, and transactional descendant revocation. Report delivery remains simulated.

## Setup after the hackathon

1. Install dependencies with `npm ci` and apply migrations in order, including `supabase/migrations/20261013000000_lineage_and_containment.sql`, to a development Supabase database. Back up an existing database before migration. The new migration preserves rows and audit history.
2. Configure the broker using `example.server.env`. Generate two distinct random tokens (at least 32 characters), for agent operations and trusted hooks. The broker is scoped to the configured user and refuses baseline mode. Run it with `node --env-file=/absolute/private/path/server.env --import tsx src/broker.ts` from an isolated service checkout.
3. Configure the MCP client with the broker URL and agent token only. `example.agent.env` shows the shape; local development uses an ignored `.env.agent`. The MCP server refuses to start if it inherits a Supabase secret or service-role key.
4. Configure a trusted hook runner with the broker URL and hook token. `example.hook.env` shows the shape; local development uses an ignored `.env.hook`. Hook failures block execution. The existing `.claude/settings.json` and `.mcp.json` now use these separate files instead of loading `.env.local`.
5. Start the dashboard with Supabase URL, publishable key, and configured owner ID. It uses the signed-in human JWT for review, inspection, and revocation, never the broker's service key. `npm run dashboard` remains available for local development; for deployment pass environment variables and run `node --import tsx src/dashboard.ts` directly.

## Security boundary required for deployment

Separate processes running as the same unrestricted OS user are **not** credential isolation. For a real deployment, run the broker and trusted hook collector outside the agent's container, filesystem mounts, process environment, and network credential access. Make hook code/configuration immutable to the agent. The agent receives only the agent token, and cannot read the hook token or dashboard credentials. The broker's hook endpoint accepts provenance only with the separate hook token. There is no agent endpoint for approval, revocation, ledger insertion, or arbitrary database queries.

Local `.env.hook` files are a development convenience, not a production trust boundary. An unrestricted local Bash tool could read them. Do not run the agent from a shell exporting server secrets, or mount `.env.local`/the server environment into the agent container. Existing local credentials have not been moved or deployed by this change. Remove server secrets from the agent's checkout when configuring the isolated deployment.

Use HTTPS for a remote broker. Its client rejects plaintext remote URLs. For multi-user deployment, provision separate broker instances/user-scoped credentials; this version is not a multi-tenant token registry.

## Inspection and containment

The dashboard's **Inspect lineage & usage** link opens the selected memory's original ledger source, ancestor and descendant links, chronological usage events, session IDs, and affected simulated Outbox actions. The RPC reads through the signed-in user's RLS policies, without a recent-history cutoff. Historical rows lacking newer usage instrumentation cannot be reconstructed automatically.

Usage distinguishes `injected`, `recalled_by_tool`, `withheld`, `applied_in_action`, and `blocked_in_action`. Context-limit exclusions are logged as withheld, not injected. Action events carry the Outbox ID. Outbox entries retain both applied and considered recipient memories, so a blocked suspicious recipient can be traced too.

**Revoke memory and descendants** atomically revokes the selected active/quarantined memory and all its derived descendants, removes sharing flags, and preserves audit events. Replacing an active preference also revokes its descendants. Revocation prevents future retrieval and authorization; it cannot remove text already present in a running agent's context or undo past deliveries. Start a new session after containment. Lineage depends on declared parent IDs; undeclared semantic dependencies cannot be inferred by this implementation.

Authorization treats quotes, blockquotes, fenced code, inline code, and pasted-content blocks as lower-trust content. Inspection/translation requests and reported speech cannot establish a direct preference. Ambiguous requests require review. This deterministic parser is intentionally conservative, not a universal natural-language intent classifier.

## Verification

`npm run typecheck` and `npm test` include broker capability-boundary tests, quoted-instruction regressions, usage logging/context-limit tests, and a disposable embedded PostgreSQL test applying every migration. Database tests verify a three-level cascade, one audit event per node, cross-user RLS, owner-only revocation, and revoked-parent rejection. Hosted Supabase integration tests require separate development credentials and are skipped otherwise.
