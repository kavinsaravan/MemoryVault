# MemoryVault roadmap

## Implemented

- Provenance ledger and conservative deterministic authorization checks.
- Separate trusted broker with scoped agent/hook capabilities.
- Authenticated memory review and read-only sharing.
- Source, lineage, session-usage, and Outbox inspection.
- Cascading revocation, immutable provenance, and parent-trust enforcement.
- Policy replay, broker tests, and disposable PostgreSQL migration tests.

## Next priorities

1. Provide a reproducible deployment with an isolated agent, broker, and trusted hook collector. Local same-user processes are not an isolation boundary.
2. Add a reproducible live-agent benchmark measuring actual attack uptake, legitimate preference retention, and false quarantines.
3. Add revision-bound review and clearer session-containment guidance.
4. Improve lineage inspection with search, filtering, and affected-session/action exports.
5. Design team workspaces, member roles, and multi-user broker authentication.
6. Evaluate a separate semantic content checker that can veto acceptance but cannot grant authority.

Future features are proposals, not claims about current capabilities. Real email delivery remains outside the current implementation.
