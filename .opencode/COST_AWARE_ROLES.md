# Cost-aware role configuration

This directory defines the first configuration-only phase of cost-aware multi-model orchestration. Roles are stable responsibilities; models are replaceable workers.

## Model bindings

Role-to-model assignments are centralized in `opencode.jsonc` under `agent`. Change those values to use different providers or models without editing the role prompts.

The initial local bindings are:

| Role           | Purpose                                | Current model                                       |
| -------------- | -------------------------------------- | --------------------------------------------------- |
| `architect`    | Planning and architecture analysis     | `openrouter/anthropic/claude-sonnet-4.6`            |
| `cheap-coder`  | Low-risk and mechanical implementation | `openrouter/poolside/laguna-xs-2.1:free`            |
| `strong-coder` | Complex or escalated implementation    | `openrouter/nvidia/nemotron-3-super-120b-a12b:free` |
| `reviewer`     | Independent, read-only review          | `openrouter/nvidia/nemotron-3-nano-30b-a3b:free`    |

Provider credentials remain in OpenCode's credential store. Do not add API keys to this repository.

The coding and Reviewer bindings above are the current zero-cost smoke-test configuration. They intentionally use explicit, different free model IDs so Phase 5 can verify independent review without relying on a random free-model router. Free-model capacity and rate limits can change, so use this configuration for low-risk tasks and acceptance tests rather than as a production-quality guarantee.

## Manual usage

Invoke a role directly with an `@` mention:

```text
@architect plan the implementation and identify affected contracts
@cheap-coder implement this low-risk change and run focused validation
@strong-coder diagnose and fix this cross-module failure
@reviewer review the current uncommitted changes
```

Use `/review` for an independent Reviewer child session:

```text
/review
/review <commit>
/review <branch>
/review <pull-request>
```

Use `/orchestrate` to inspect a request, call the deterministic task router, and delegate to the selected role:

```text
/orchestrate implement a small configuration change and run focused validation
```

The router returns a role, a machine-readable reason, and whether independent review is recommended. It never returns or selects a provider-specific model.

The initial rules are evaluated in this order:

1. Explicit review requests go to `reviewer`.
2. Architecture work or unclear requirements go to `architect`.
3. Security, migration, and contract work goes to `strong-coder` and requires review.
4. High-risk, high-complexity, or large-scope work goes to `strong-coder`.
5. Two prior failures escalate to `strong-coder`.
6. Large-context work affecting at least eight files goes to `strong-coder`.
7. Medium-risk work without automated tests goes to `strong-coder` and requires review.
8. Everything else tries `cheap-coder` first, including ordinary medium-complexity work.

The Phase 3 retry and escalation policy is configured in `.opencode/opencode.jsonc` under `cost_aware`. It is provider-neutral:

```jsonc
"cost_aware": {
  "max_attempts": 3,
  "max_escalations": 1,
  "max_cost_usd": 5,
  "cheap_coder_failures_before_escalation": 2,
  "strong_coder_failures_before_human": 2,
}
```

`/orchestrate` now forces one `orchestrate_task` call: the first provider turn can see only that tool and must call it, while later turns cannot call more tools. The internal force marker is read from the trusted command template before user arguments are expanded, so request text cannot inject another forced tool. The composite tool persists local state under `.opencode/task-state/` (ignored by Git), delegates the routed role, records command-level validation results, retries the same role within budget, and escalates the Cheap Coder to the Strong Coder after the configured number of failed checks. A passed deterministic validation moves the task to independent review automatically. Interrupted workflows may be continued with the same task ID and `resume: true`.

After each delegated role finishes, OpenCode reads the child session's saved model, provider, input/output/reasoning/cache token totals, and estimated USD cost. The task summary groups this data by role/provider/model and totals it without double-counting a resumed child session. `max_cost_usd` is an assumed per-task budget of $5 for this local setup; change it or remove it to track costs without automatically stopping additional attempts.

The implementation and reviewer bindings should use different model identities where possible. Phase 5 enforces this before review: it compares the actual final author provider/model saved by OpenCode with the Reviewer role's configured provider/model, and refuses to claim independent review when either identity is unavailable or both are the same. Review results, reviewer model identity, and unavailable-review reasons are retained in the local task state. A reviewer `PASS` completes the task; `FAIL` returns the task to a bounded coding repair loop.

## Current boundary

The current implementation provides manually invoked roles, automatic model-independent review through `/orchestrate`, deterministic task routing, persisted validation and review state, validation-driven retries, bounded Cheap Coder escalation, task budgets, and task-level model/token/cost summaries. It does not yet include parallel specialist worktrees or distributed workers.

## Phase 5 验收记录

Phase 5 completes only when all three conditions are met:

1. Deterministic validation passed.
2. The author's actual provider/model differs from the Reviewer's actual provider/model.
3. The Reviewer explicitly reports `PASS`.

Runtime identities, token usage, review history, retries, escalation counts, and estimated cost are authoritative only when read from the task's generated state file. This document intentionally does not duplicate or invent a task-specific acceptance result.
