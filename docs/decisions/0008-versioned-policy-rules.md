# ADR-0008: Versioned global policy rules

Date: 2026-09-24
Status: Accepted

## Decision

Global rules live in `policy_rules` as append-only revisions, uniquely identified
by `(key, version)`. Latest revision wins, including a disabled revision: disabling
must never resurrect an older active version. Creation, editing, activation and
deactivation use the same revision API with an expected previous version. A unique
constraint rejects concurrent stale revisions with HTTP 409. Audit and revision
creation are one transaction.

`User.isPlatformAdmin` is a separate, default-false privilege. Tenant OWNER/ADMIN
roles do not grant global rule management. Active sessions and memberships are
still required. Privilege is checked from the database on each management request;
no client-submitted role or public self-promotion endpoint exists.

The existing multilingual matchers are immutable V1 implementations. Their risk,
explanation and active status are revisioned in the database. New phrase-list rules
use normalized literal matching, not user-supplied regular expressions. A matcher
algorithm change requires a new matcher identifier to preserve historical meaning.
The migration installs the three existing rules; it does not grant admin access.

Campaign and Studio operations load a fresh rule snapshot. Results contain the
engine version plus every selected rule key/version/active flag, even unmatched
and disabled rules. Submit, approve, publish and activation recheck current rules.
Database errors or missing bootstrap rules fail closed; there is no silent fallback
to a different rule set in server workflows. Pure package consumers retain the
built-in snapshot as their default for compatibility.

## Operations

An operator with trusted database access grants or revokes `User.isPlatformAdmin`
for an existing user. For example, in Prisma Studio select the intended User and
set the flag explicitly. No existing/demo user is promoted automatically. The
user must also have an active tenant membership to sign in with the current auth.
The management screen is `/policy-rules`; APIs are `/api/policy-rules` and
`/api/policy-rules/[key]` (history).

## Consequences

Global rule edits affect all tenants on subsequent checks, not completed historical
checks. Existing running ads are not automatically paused. A check records its
snapshot; a rule change concurrent with an in-flight Meta request does not cancel
that request. This package adds deterministic rule management, not an LLM risk
review or collection of Meta rejection reasons.
