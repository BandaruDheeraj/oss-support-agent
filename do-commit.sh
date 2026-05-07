git add --all
git commit -m "feat(US-019): Cost guardrails, fork cleanup, and run history dashboard" -m "Implement per-run token/cost caps, fork cleanup policies, and a CLI run
history dashboard for production operability.

- Cost guardrails: configurable per-run token and cost caps (null=unlimited),
  breach detection halts run and emails user with partial state, accumulates
  usage across agent invocations, checks token cap before cost cap
- Fork cleanup: configurable policy (immediate-after-merge | delayed | never),
  default delayed with 72h delay, immediate deletes branch and fork if empty,
  delayed returns scheduled timestamp for cron execution
- Run history dashboard: CLI view listing runs with state, duration, retry count,
  cost, and PR URL; aggregate stats with success rate, totals, and by-state breakdown
- Scenario validation: all 4 PRD section 8.1 types (simple bug fix, feature with
  design, retry success, max retries exceeded) with outcome validators
- Types: CostConfig, RunUsage, CostCheckResult, CostBreachNotification,
  ForkCleanupConfig/Result/Policy, RunHistoryEntry/Filter/Stats, error classes
- 30+ unit tests covering all acceptance criteria" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"

