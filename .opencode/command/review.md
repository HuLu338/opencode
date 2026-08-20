---
description: Run an independent review with the configured Reviewer role.
agent: reviewer
subtask: true
---

Perform an independent code review for this target:

$ARGUMENTS

If no target was provided, review all uncommitted changes. Do not implement fixes. Inspect the requirements, Git diff and status, complete changed files, relevant contracts, and available validation results. Return actionable findings followed by validation, requirement coverage, a PASS or FAIL decision, and remaining risks.
