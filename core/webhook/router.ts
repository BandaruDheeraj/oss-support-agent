import { IssueEvent, WebhookResult } from './types';
import { Manifest } from '../manifest/types';
import { StateMachine } from '../orchestrator/state-machine';
import { RunState } from '../orchestrator/types';
import { randomUUID } from 'crypto';

/**
 * Manifest registry interface: look up a manifest by repo full_name.
 */
export interface ManifestRegistry {
  getManifest(repo: string): Manifest | null;
}

/**
 * Route and process a GitHub issue event.
 *
 * - Looks up the manifest for the repo; if none, enters SKIPPED.
 * - For issue.opened: creates a run in TRIGGERED state.
 * - For issue.labeled: checks trigger_label (or skip_pm_gate_label) before creating a run.
 * - Other events/actions are ignored.
 */
export function routeEvent(
  event: IssueEvent,
  eventType: string,
  registry: ManifestRegistry,
  stateMachine: StateMachine
): WebhookResult {
  // Only handle issue events
  if (eventType !== 'issues') {
    return { status: 'ignored', reason: `Unsupported event type: ${eventType}` };
  }

  const repo = event.repository.full_name;

  // Only handle opened and labeled actions
  if (event.action !== 'opened' && event.action !== 'labeled') {
    return { status: 'ignored', reason: `Unsupported action: ${event.action}` };
  }

  // Look up manifest
  const manifest = registry.getManifest(repo);

  if (!manifest) {
    // No manifest for this repo → create run and move to SKIPPED
    const runId = randomUUID();
    stateMachine.createRun(runId, repo, [event.issue.number]);
    stateMachine.transition(runId, RunState.SKIPPED);
    return { status: 'skipped', reason: `No manifest found for repo: ${repo}` };
  }

  // For issue.labeled, check if the label matches trigger_label or skip_pm_gate_label
  if (event.action === 'labeled') {
    const labelName = event.label?.name;
    if (!labelName) {
      return { status: 'ignored', reason: 'Labeled event without label name' };
    }

    const isTriggerLabel = labelName === manifest.trigger_label;
    const isSkipPmGateLabel = labelName === manifest.skip_pm_gate_label;

    if (!isTriggerLabel && !isSkipPmGateLabel) {
      return {
        status: 'ignored',
        reason: `Label '${labelName}' does not match trigger_label '${manifest.trigger_label}'`,
      };
    }
  }

  // Create a run in TRIGGERED state
  const runId = randomUUID();
  stateMachine.createRun(runId, repo, [event.issue.number]);

  return { status: 'accepted', runId };
}
