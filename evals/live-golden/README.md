# Live Golden Runs

This folder defines the minimum live e2e checks for `oss-support-agent`.

These cases are intentionally small and explicit. A run is green only when it
reaches a draft PR with:

- a verified failing repro committed before the fix,
- a fix committed after the repro,
- GHA sandbox output parsed from `sandbox-output`,
- regression/usability verification recorded or explicitly skipped with reason,
- a completed record under `STATE_ROOT/pipeline-runs`.

Use these cases before widening the agent to new repos or issue classes.

