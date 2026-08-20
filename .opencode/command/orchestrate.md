---
description: Run a bounded coding task with deterministic routing, validation, escalation, cost tracking, and independent review.
agent: build
subtask: false
---

<!-- opencode-force-tool: orchestrate_task -->

Orchestrate this request:

$ARGUMENTS

Inspect only enough repository context to classify the task and choose the exact allowed files plus the smallest relevant deterministic validation commands. Then call `orchestrate_task` exactly once. Generate a short stable task ID when the request does not provide one.

The composite tool owns routing, persisted state, role delegation, actual provider/model/token/cost collection, deterministic validation, bounded retry and escalation, and cross-model Reviewer assignment. Do not call `route_task`, `task_state`, `task`, or validation shell commands separately. Do not implement the request yourself, edit `.opencode/task-state`, invent usage, infer a vague review decision, or start a second workflow after a blocked result.

Return the tool's final summary in Chinese. A completed Phase 5 task must show deterministic validation passed, actual author and Reviewer provider/model identities differ, and the Reviewer explicitly returned `PASS`. Report any unresolved risk from a non-completed result.
