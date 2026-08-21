# Cost-aware role configuration

This directory defines the first configuration-only phase of cost-aware multi-model orchestration. Roles are stable responsibilities; models are replaceable workers.

## Model bindings

Role-to-model assignments are centralized in `opencode.jsonc` under `agent`. Change those values to use different providers or models without editing the role prompts.

The initial local bindings are:

| Role           | Purpose                                | Primary model          | Fallback model             |
| -------------- | -------------------------------------- | ---------------------- | -------------------------- |
| `architect`    | Planning and architecture analysis     | `openai/gpt-5.6-terra` | `openai/gpt-5.5`           |
| `cheap-coder`  | Low-risk and mechanical implementation | `openai/gpt-5.4-mini`  | `openai/gpt-5.4-mini-fast` |
| `strong-coder` | Complex or escalated implementation    | `openai/gpt-5.5`       | `openai/gpt-5.6-terra`     |
| `reviewer`     | Independent, read-only review          | `openai/gpt-5.6-luna`  | `openai/gpt-5.4`           |

Provider credentials remain in OpenCode's credential store. Do not add API keys to this repository.

All eight configured role/model paths were checked with a real one-turn `OK` request using the local OpenAI/Codex account authorization. OpenCode's provider catalog reports zero marginal token price for these OAuth-backed models, but this does not promise unlimited free usage: account, product, rate, and quota limits still apply.

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
  "model_pools": {
    "architect": ["openai/gpt-5.6-terra", "openai/gpt-5.5"],
    "cheap-coder": ["openai/gpt-5.4-mini", "openai/gpt-5.4-mini-fast"],
    "strong-coder": ["openai/gpt-5.5", "openai/gpt-5.6-terra"],
    "reviewer": ["openai/gpt-5.6-luna", "openai/gpt-5.4"]
  },
  "pricing_usd_per_million": {
    "openai/gpt-5.4-mini": { "input": 0, "output": 0 },
    "openai/gpt-5.4-mini-fast": { "input": 0, "output": 0 },
    "openai/gpt-5.4": { "input": 0, "output": 0 },
    "openai/gpt-5.5": { "input": 0, "output": 0 },
    "openai/gpt-5.6-luna": { "input": 0, "output": 0 },
    "openai/gpt-5.6-terra": { "input": 0, "output": 0 }
  },
  "sandbox": {
    "enabled": true,
    "image": "opencode-cost-aware-sandbox:local",
    "network": "none",
    "memory_mb": 4096,
    "cpus": 2,
    "pids_limit": 512
  }
}
```

`/orchestrate` now forces one `orchestrate_task` call: the first provider turn can see only that tool and must call it, while later turns cannot call more tools. The internal force marker is read from the trusted command template before user arguments are expanded, so request text cannot inject another forced tool. The composite tool persists local state under `.opencode/task-state/` (ignored by Git), delegates the routed role, records command-level validation results, retries the same role within budget, and escalates the Cheap Coder to the Strong Coder after the configured number of failed checks. A passed deterministic validation moves the task to independent review automatically. Interrupted workflows may be continued with the same task ID and `resume: true`.

Each role has an ordered, bounded model pool. Authentication, rate-limit, quota, unavailable-model, timeout, network, provider, and compatible invalid-request failures are recorded as infrastructure failures and move to the next model without consuming a code-validation attempt. An unknown model failure stops the workflow instead of hiding it, and exhausting a pool is a blocked result. Implementation retries and role escalation remain driven only by deterministic validation or Reviewer findings.

After each delegated role finishes or fails, OpenCode reads the child session's saved model, provider, input/output/reasoning/cache token totals, and estimated USD cost. The task summary groups this data by role/provider/model and totals it without double-counting a resumed child session. Cost records identify whether pricing came from explicit `pricing_usd_per_million` configuration, non-zero provider metadata, or was unavailable. Because OpenCode's normalized provider catalog cannot distinguish a genuinely free model from missing prices when every rate is zero, intentional zero-cost models must be listed explicitly. Summaries distinguish `estimated`, `partial`, and `unavailable` cost coverage. When `max_cost_usd` is configured, missing pricing blocks further model calls because the cap cannot be proven; remove the cap to continue tracking with an explicit unavailable-cost warning. `max_cost_usd` is an assumed per-task budget of $5 for this local setup.

The implementation and reviewer bindings should use different model identities where possible. Phase 5 enforces this before review: it compares the actual final author provider/model saved by OpenCode with the Reviewer role's configured provider/model, and refuses to claim independent review when either identity is unavailable or both are the same. Review results, reviewer model identity, and unavailable-review reasons are retained in the local task state. A reviewer `PASS` completes the task; `FAIL` returns the task to a bounded coding repair loop.

## Current boundary

The current implementation provides manually invoked roles, tested per-role model bindings, bounded per-role model pools, infrastructure-failure fallback, automatic model-independent review through `/orchestrate`, deterministic task routing, persisted validation and review state, validation-driven retries, bounded Cheap Coder escalation, truthful task-budget status, and task-level model/token/cost summaries. It does not yet include parallel specialist worktrees or distributed workers.

## Phase 5 验收记录

Phase 5 completes only when all three conditions are met:

1. Deterministic validation passed.
2. The author's actual provider/model differs from the Reviewer's actual provider/model.
3. The Reviewer explicitly reports `PASS`.

Runtime identities, token usage, review history, retries, escalation counts, and estimated cost are authoritative only when read from the task's generated state file. This document intentionally does not duplicate or invent a task-specific acceptance result.

## 项目六：桌面体验验收

1. 重启后命令识别正常。
2. 权限状态不挂起。
3. 状态路径正确可用。
4. 中文摘要可正常展示。
5. 恢复命令可继续任务。
6. 模型、Token、重试与成本信息可见。

`PHASE6-UX-001` 已通过全新 CLI 进程完成上述编排闭环：确定性验证通过，作者为 `openai/gpt-5.4-mini`，独立 Reviewer 为 `openai/gpt-5.6-luna`，Reviewer 明确 `PASS`，无重试或升级。打包版桌面窗口在本机仍受 Electron GPU 子进程 `0xC0000135` 启动错误影响；这是桌面运行环境风险，不改变该编排状态记录。

## 项目七：本地安全沙箱

构建一次本地验证镜像：

```text
docker build -f packages/opencode/sandbox/Dockerfile -t opencode-cost-aware-sandbox:local .
```

确认镜像可用后，将 `cost_aware.sandbox.enabled` 改为 `true`。此后 `/orchestrate` 的确定性验证在临时 Docker 容器中运行；实现和审查仍由宿主 OpenCode 会话负责。

沙箱固定使用只读根文件系统、无 Linux capabilities、`no-new-privileges`、进程/内存/CPU 上限和默认断网。宿主只把当前仓库以只读方式挂载到 `/workspace`；容器将过滤后的工作副本复制到一次性 `/work` 卷再执行测试或构建，不挂载 Docker socket、`.ssh`、浏览器资料、个人目录、环境文件或本地任务状态。Docker 基础设施不可用时验证结果记为 `unavailable`，不会消耗编码重试次数。

## Phase 7 Docker 运行验收

`PHASE7-SANDBOX-001` 的确定性验证在 `executor=docker`、`network=none`、仓库只读挂载下通过。
