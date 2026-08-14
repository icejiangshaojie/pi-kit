---
description: Worker implements, reviewer reviews, worker applies feedback
---

Use the subagent tool with the chain parameter:

1. Worker implements: $@
2. Reviewer reviews the implementation using `{previous}`.
3. Worker applies the review feedback using `{previous}`.

Execute this as a chain, passing output between steps via `{previous}`.
If the subagent tool is unavailable, implement, review, and address findings in the current session instead.
