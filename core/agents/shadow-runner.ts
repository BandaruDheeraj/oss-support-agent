/**
 * Shadow runner. Wraps the v2 loops so the production pipeline can run
 * them alongside legacy in `shadow` mode without affecting outputs.
 *
 *   REPRO_AGENT_MODE = oneshot | shadow | loop
 *   FIX_AGENT_MODE   = oneshot | shadow | loop
 *
 * - oneshot: legacy code path runs, v2 not invoked.
 * - shadow:  legacy is authoritative; v2 runs dry (no commits / PRs) and
 *            its outcome is written to eval-recorder with mode='shadow_loop'.
 * - loop:    v2 is authoritative; legacy not invoked.
 */

export type AgentMode = 'oneshot' | 'shadow' | 'loop';

export function reproMode(): AgentMode {
  return ((process.env.REPRO_AGENT_MODE || 'oneshot').toLowerCase() as AgentMode);
}

export function fixMode(): AgentMode {
  return ((process.env.FIX_AGENT_MODE || 'oneshot').toLowerCase() as AgentMode);
}

export interface ShadowDecision {
  runLegacy: boolean;
  runV2: boolean;
  v2Authoritative: boolean;
  v2DryRun: boolean;
}

export function decisionFor(mode: AgentMode): ShadowDecision {
  switch (mode) {
    case 'loop':
      return { runLegacy: false, runV2: true, v2Authoritative: true, v2DryRun: false };
    case 'shadow':
      return { runLegacy: true, runV2: true, v2Authoritative: false, v2DryRun: true };
    case 'oneshot':
    default:
      return { runLegacy: true, runV2: false, v2Authoritative: false, v2DryRun: false };
  }
}
