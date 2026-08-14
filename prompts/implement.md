---
description: Full implementation workflow - scout gathers context, planner creates plan, worker implements
---

Use the subagent tool with the chain parameter:

1. Scout all code relevant to: $@
2. Planner creates an implementation plan for `$@` using `{previous}`.
3. Worker implements that plan using `{previous}`.

Execute this as a chain, passing output between steps via `{previous}`.
If the subagent tool is unavailable, perform the same scout, plan, and implementation stages yourself with the current tools.
