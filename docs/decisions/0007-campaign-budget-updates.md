# ADR-0007: Campaign budget updates

Date: 2026-09-24
Status: Accepted

## Decision

`PATCH /api/campaigns/[id]/budget` accepts a positive integer `dailyBudget`
and optional `reason`. It follows the current campaign create/publish API's
major-unit convention (Meta receives `dailyBudget * 100`). This convention
differs from the schema's minor-unit comment; currency-unit normalization
across existing campaign producers remains a separate migration task.

OWNER/ADMIN may increase the budget; MEDIA_BUYER may only keep or reduce it.
The endpoint checks the proposed daily budget times 30 against the existing
organization cap, matching campaign creation. This is a per-campaign projection,
not enforcement of aggregate tenant spend across campaigns.

A scoped campaign row lock serializes budget edits before comparing the old
and new budgets. Budget and audit persistence share a transaction. Published
campaigns require a connected, unexpired tenant-owned Meta connection, and
the existing Meta client's updateBudget operation must succeed before the
local budget is updated. Archived/deleted and lifetime-budget campaigns are
rejected. Equal budgets are no-ops.

## Consequences

Meta failures leave the local budget and audit unchanged. The external API
and PostgreSQL are not an atomic transaction: if Meta succeeds but the DB
commit fails, reconciliation is needed. An upstream timeout can also leave
the remote result unknown. Row locking protects budget endpoint requests;
it does not coordinate other Meta writers or external Ads Manager edits.

Integration tests exercise roles, tenant isolation, cap boundaries, input
validation, mock Meta calls/failures, connection state, and audit persistence.
