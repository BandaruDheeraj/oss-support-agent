import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { createWebhookServer, WebhookServerOptions } from '../server';
import { computeSignature } from '../signature';
import { ManifestRegistry } from '../router';
import { StateMachine } from '../../orchestrator/state-machine';
import { RunState } from '../../orchestrator/types';
import { Manifest } from '../../manifest/types';

const TEST_SECRET = 'test-webhook-secret-do-not-use';

const SAMPLE_MANIFEST: Manifest = {
  repo: 'test-org/test-repo',
  trigger_label: 'agent-fix',
  skip_pm_gate_label: 'trivial-fix',
  fork_org: 'test-fork-org',
  branch_prefix: 'agent/scope-',
  approval_keywords: ['approved', 'lgtm'],
  pm_email: 'pm@test.com',
  max_retries: 3,
  sandbox_timeout_mins: 15,
};

function makeRegistry(manifests: Record<string, Manifest>): ManifestRegistry {
  return {
    getManifest(repo: string) {
      return manifests[repo] || null;
    },
  };
}

function makeTempDbPath(): string {
  return path.join(os.tmpdir(), `webhook-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function sendRequest(
  server: http.Server,
  opts: {
    body: string;
    secret?: string;
    eventType?: string;
    method?: string;
    path?: string;
  }
): Promise<{ statusCode: number; body: any }> {
  return new Promise((resolve, reject) => {
    const addr = server.address() as { port: number };
    const signature = opts.secret
      ? computeSignature(opts.body, opts.secret)
      : 'sha256=invalid';

    const reqOpts: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: addr.port,
      path: opts.path || '/webhook',
      method: opts.method || 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
        ...(opts.eventType ? { 'X-GitHub-Event': opts.eventType } : {}),
      },
    };

    const req = http.request(reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          body = raw;
        }
        resolve({ statusCode: res.statusCode!, body });
      });
    });

    req.on('error', reject);
    req.write(opts.body);
    req.end();
  });
}

function makeIssueOpenedPayload(repo: string, issueNumber: number) {
  return JSON.stringify({
    action: 'opened',
    issue: {
      number: issueNumber,
      title: 'Test issue',
      body: 'Test body',
      labels: [],
      user: { login: 'testuser' },
    },
    repository: { full_name: repo },
  });
}

function makeIssueLabeledPayload(repo: string, issueNumber: number, labelName: string) {
  return JSON.stringify({
    action: 'labeled',
    issue: {
      number: issueNumber,
      title: 'Test issue',
      body: 'Test body',
      labels: [{ name: labelName }],
      user: { login: 'testuser' },
    },
    label: { name: labelName },
    repository: { full_name: repo },
  });
}

describe('Webhook Server Integration', () => {
  let server: http.Server;
  let stateMachine: StateMachine;
  let dbPath: string;

  beforeEach((done) => {
    dbPath = makeTempDbPath();
    stateMachine = new StateMachine(dbPath);
    const registry = makeRegistry({
      'test-org/test-repo': SAMPLE_MANIFEST,
    });

    const opts: WebhookServerOptions = {
      port: 0, // random port
      secret: TEST_SECRET,
      registry,
      stateMachine,
    };
    server = createWebhookServer(opts);
    server.listen(0, '127.0.0.1', done);
  });

  afterEach((done) => {
    stateMachine.close();
    server.close(done);
  });

  describe('Signature verification', () => {
    it('rejects requests with invalid signature', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 1);
      const res = await sendRequest(server, {
        body,
        secret: 'wrong-secret',
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(401);
      expect(res.body.error).toBe('Invalid signature');
    });

    it('rejects requests with missing signature', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 1);
      const addr = server.address() as { port: number };

      const res = await new Promise<{ statusCode: number; body: any }>((resolve, reject) => {
        const reqOpts: http.RequestOptions = {
          hostname: '127.0.0.1',
          port: addr.port,
          path: '/webhook',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'issues',
            // No X-Hub-Signature-256 header
          },
        };

        const req = http.request(reqOpts, (resp) => {
          const chunks: Buffer[] = [];
          resp.on('data', (chunk) => chunks.push(chunk));
          resp.on('end', () => {
            resolve({
              statusCode: resp.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          });
        });
        req.on('error', reject);
        req.write(body);
        req.end();
      });

      expect(res.statusCode).toBe(401);
    });

    it('accepts requests with valid signature', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 1);
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('accepted');
    });
  });

  describe('Event routing', () => {
    it('returns 404 for non-POST or non-/webhook paths', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 1);
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
        path: '/other',
      });
      expect(res.statusCode).toBe(404);
    });

    it('ignores non-issue events (e.g. push)', async () => {
      const body = JSON.stringify({ ref: 'refs/heads/main' });
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'push',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(res.body.reason).toContain('Unsupported event type');
    });

    it('creates a run in TRIGGERED state for issue.opened with a manifest', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 42);
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('accepted');
      expect(res.body.runId).toBeDefined();

      // Verify run was created
      const run = stateMachine.getRun(res.body.runId);
      expect(run).not.toBeNull();
      expect(run!.state).toBe(RunState.TRIGGERED);
      expect(run!.repo).toBe('test-org/test-repo');
      expect(run!.issue_ids).toEqual([42]);
    });

    it('enters SKIPPED state for repos with no manifest', async () => {
      const body = makeIssueOpenedPayload('unknown-org/unknown-repo', 10);
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('skipped');
      expect(res.body.reason).toContain('No manifest');
    });

    it('creates a run for issue.labeled with trigger_label', async () => {
      const body = makeIssueLabeledPayload('test-org/test-repo', 55, 'agent-fix');
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('accepted');

      const run = stateMachine.getRun(res.body.runId);
      expect(run).not.toBeNull();
      expect(run!.state).toBe(RunState.TRIGGERED);
    });

    it('ignores issue.labeled with non-matching label', async () => {
      const body = makeIssueLabeledPayload('test-org/test-repo', 55, 'bug');
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(res.body.reason).toContain('does not match trigger_label');
    });

    it('ignores unsupported actions (e.g. issue.closed)', async () => {
      const body = JSON.stringify({
        action: 'closed',
        issue: {
          number: 1,
          title: 'Test',
          body: null,
          labels: [],
          user: { login: 'test' },
        },
        repository: { full_name: 'test-org/test-repo' },
      });
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('ignored');
      expect(res.body.reason).toContain('Unsupported action');
    });

    it('responds within reasonable time (under 1 second)', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 99);
      const start = Date.now();
      await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(1000);
    });
  });

  describe('skip_pm_gate_label handling', () => {
    it('accepts issue.labeled with skip_pm_gate_label', async () => {
      const body = makeIssueLabeledPayload('test-org/test-repo', 77, 'trivial-fix');
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      expect(res.statusCode).toBe(202);
      expect(res.body.status).toBe('accepted');
    });
  });

  describe('Secret handling', () => {
    it('webhook secret is never in response body', async () => {
      const body = makeIssueOpenedPayload('test-org/test-repo', 1);
      const res = await sendRequest(server, {
        body,
        secret: TEST_SECRET,
        eventType: 'issues',
      });
      const responseStr = JSON.stringify(res.body);
      expect(responseStr).not.toContain(TEST_SECRET);
    });
  });
});
