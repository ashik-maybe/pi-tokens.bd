---
description: Plan a task with cost awareness using tokens.bd usage and pricing.
argument-hint: "[task]"
---
# Cost-aware plan: $ARGUMENTS

Produce a compact implementation plan with cost awareness. Do not write implementation code.

## Steps

1. `/tokens status` to check remaining windows and key caps.
2. If the task may be large, `/tokens count --model <id> <text>` for an exact, non-billed input count.
3. Pick the cheapest `tokens.bd/<role>` ladder model sufficient for the task. Candidates: `fast`, `coder`, `long-context`, `reasoner`, `private`, `research`, `auto`.
4. List the plan:
   - Goal
   - Constraints
   - Affected files
   - Implementation steps
   - Verification commands
   - Risks
   - Estimated tokens (input and output) and rough cost
   - Recommended model (cheapest that fits)

## Rules

- If the remaining window is low or `percentUsed` is high, shrink scope or pause.
- Keep tool definitions and system prompt stable and first; append to history, do not rewrite it, to preserve the cache prefix.
- Set `max_tokens` close to the expected answer size; reservation uses it and a wide value can block near a key cap.
- Never inline credentials; use `TOKENS_API_KEY` in the shell environment.
- Surface the exact commands the user should run next (for example: `/tokens compare`, `/compact`).
