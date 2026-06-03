import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FilePipelineRunStateStore } from './state-stores';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'osa-state-'));
}

describe('FilePipelineRunStateStore', () => {
  it('blocks duplicate running issue runs from the same instance', () => {
    const store = new FilePipelineRunStateStore(tempRoot());
    const first = store.acquireRun({
      key: 'owner/repo#42',
      repoFullName: 'owner/repo',
      issueNumber: 42,
      action: 'labeled',
      labelName: 'agent-fix',
      instanceId: 'instance-a',
    });
    const second = store.acquireRun({
      key: 'owner/repo#42',
      repoFullName: 'owner/repo',
      issueNumber: 42,
      action: 'labeled',
      labelName: 'agent-fix',
      instanceId: 'instance-a',
    });

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(false);
    expect(second.reason).toBe('already-running');
    expect(second.record.instanceId).toBe('instance-a');
  });

  it('allows a new instance to reacquire a run left running by a dead instance', () => {
    const store = new FilePipelineRunStateStore(tempRoot());
    store.acquireRun({
      key: 'owner/repo#42',
      repoFullName: 'owner/repo',
      issueNumber: 42,
      action: 'labeled',
      instanceId: 'instance-old',
    });

    // New deploy creates instance-new; instance-old was killed and its run is dead.
    const reacquired = store.acquireRun({
      key: 'owner/repo#42',
      repoFullName: 'owner/repo',
      issueNumber: 42,
      action: 'labeled',
      instanceId: 'instance-new',
    });

    expect(reacquired.acquired).toBe(true);
  });

  it('allows a stale running issue run to be reacquired', () => {
    const store = new FilePipelineRunStateStore(tempRoot());
    const start = new Date('2026-06-02T00:00:00.000Z');
    store.acquireRun(
      {
        key: 'owner/repo#42',
        repoFullName: 'owner/repo',
        issueNumber: 42,
        action: 'labeled',
      },
      { now: start }
    );

    const reacquired = store.acquireRun(
      {
        key: 'owner/repo#42',
        repoFullName: 'owner/repo',
        issueNumber: 42,
        action: 'labeled',
      },
      {
        staleAfterMs: 10_000,
        now: new Date('2026-06-02T00:00:11.000Z'),
      }
    );

    expect(reacquired.acquired).toBe(true);
    expect(reacquired.record.startedAt).toBe('2026-06-02T00:00:11.000Z');
  });

  it('records completed run results', () => {
    const store = new FilePipelineRunStateStore(tempRoot());
    store.acquireRun({
      key: 'owner/repo#42',
      repoFullName: 'owner/repo',
      issueNumber: 42,
      action: 'labeled',
    });

    const completed = store.completeRun('owner/repo#42', 'completed', {
      result: { status: 'pr-opened' },
      now: new Date('2026-06-02T01:00:00.000Z'),
    });

    expect(completed.status).toBe('completed');
    expect(completed.completedAt).toBe('2026-06-02T01:00:00.000Z');
    expect(store.loadRun('owner/repo#42')?.result).toEqual({ status: 'pr-opened' });
  });
});
