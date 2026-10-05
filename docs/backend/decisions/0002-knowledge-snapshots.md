# ADR 0002 — Explicit knowledge heads

Status: accepted for the v1 reference implementation, 2026-10-04. Human review pending.

Decision: every approved event names causal parent event IDs. A historical query names one or more heads and evaluates exactly their ancestor closure. Fixed event metadata and heads produce the same result regardless of JSON array order. A timestamp maps to known local heads only under a documented local policy; divergent offline branches are not globally ordered by device clocks.

Alternatives: sorting by approval timestamp or event ID is simple but would silently choose a winner between offline corrections. Using server revision as the financial clock would make historical meaning depend on sync availability. Both were rejected.

Consequence: consumers must carry explicit head IDs and surface contradictions or preserved variants. Merge decisions become new events. The first implementation covers source-based school surplus; matching and branch merge semantics get their own negative tests before support is claimed.

2026-10-05 refinement: `resolve_branches` is a reviewed causal join of two event heads. It changes which histories are visible together but contains no monetary decision. Concurrent corrections and match decisions still require explicit superseding decisions. Older parsers reject this new event even though the JSON case label remains v1; a future writer must gate publication on client compatibility.
