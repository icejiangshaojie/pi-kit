---
description: Scout gathers context, planner creates implementation plan without implementation
---

Use the subagent tool with the chain parameter:

1. Scout all code relevant to: $@
2. Planner creates an implementation plan using `{previous}`.

Execute this as a chain, passing output between steps via `{previous}`. Do not implement; return only the plan.
If the subagent tool is unavailable, perform the reconnaissance and planning stages in the current session.
