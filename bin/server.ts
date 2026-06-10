#!/usr/bin/env node
/**
 * bin/server.ts
 *
 * Phase 1 live entrypoint for the OSS Autonomous Fix-Loop harness.
 *
 * Wires:
 *   - HTTP webhook server with HMAC verification
 *   - Filesystem-backed manifest registry (configs/<org>/<repo>/manifest.yaml)
 *   - Adapter loader with runtime contract checks
 *   - Real OpenRouter-backed triage classifier (heuristic fallback)
 *   - Real GitHub REST issue commenter (low-confidence clarifications)
 *
 * Phase 1 scope intentionally stops after triage. Fix / build / sandbox /
 * eval / PR phases are logged as TODO. Introspection (auto-onboarding for
 * unknown repos) is also out of scope here — Gmail-based PM approval is
 * not yet wired for live mode, so unknown repos are rejected with a clear
 * message and the operator must run the introspection flow offline first.
 */

import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import 'dotenv/config';

import { verifySignature } from '../core/webhook/signature';
import type { IssueEvent } from '../core/webhook/types';
import { loadAdapter } from '../core/adapter-loader';
import {
  assertObservabilityConfigured,
  getObservabilityAdapterContracts,
  getObservabilityDiagnostics,
  getTracer,
  runObservabilityStartupSmoke,
} from '../core/observability';

import { FsManifestRegistry } from './clients/manifest-registry';
import { runPipeline, defaultWorkspaceRoot } from './run-pipeline';
import { buildLiveDeps, defaultStateRoot, type LiveDeps } from './clients/live-deps';
import { FilePipelineRunStateStore } from './clients/state-stores';
import { GistStateStore } from './clients/gist-state-store';

interface RequiredEnv {
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
  DEFAULT_FORK_ORG: string;
}

interface OptionalEnv {
  PORT: number;
  OPENROUTER_API_KEY: string | undefined;
  REPO_ROOT: string;
  WORKSPACE_ROOT: string;
  STATE_ROOT: string;
  GIST_ID: string | undefined;
  GIT_AUTHOR_NAME: string;
  GIT_AUTHOR_EMAIL: string;
}

function loadEnv(): RequiredEnv & OptionalEnv {
  const required: Array<keyof RequiredEnv> = ['GITHUB_TOKEN', 'WEBHOOK_SECRET', 'DEFAULT_FORK_ORG'];
  for (const name of required) {
    if (!process.env[name] || process.env[name]!.trim() === '') {
      // eslint-disable-next-line no-console
      console.error(`[fatal] Missing required env var: ${name}`);
      process.exit(1);
    }
  }

  const port = parseInt(process.env.PORT ?? '3000', 10);
  if (Number.isNaN(port)) {
    // eslint-disable-next-line no-console
    console.error(`[fatal] Invalid PORT: ${process.env.PORT}`);
    process.exit(1);
  }

  return {
    GITHUB_TOKEN: process.env.GITHUB_TOKEN!,
    WEBHOOK_SECRET: process.env.WEBHOOK_SECRET!,
    DEFAULT_FORK_ORG: process.env.DEFAULT_FORK_ORG!,
    PORT: port,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    REPO_ROOT: process.env.REPO_ROOT ?? process.cwd(),
    WORKSPACE_ROOT: process.env.WORKSPACE_ROOT ?? defaultWorkspaceRoot(),
    STATE_ROOT: process.env.STATE_ROOT ?? defaultStateRoot(),
    GIST_ID: process.env.GIST_ID,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'oss-support-agent',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'agent@users.noreply.github.com',
  };
}

function buildLog(repoFullName: string): (msg: string) => void {
  return (msg: string) => {
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`${ts} ${repoFullName} ${msg}`);
  };
}

async function processIssueEvent(
  payload: IssueEvent,
  eventType: string,
  registry: FsManifestRegistry,
  env: ReturnType<typeof loadEnv>,
  live: LiveDeps | null,
  runStateStore: FilePipelineRunStateStore
): Promise<{ status: number; body: any }> {
  if (eventType !== 'issues') {
    return { status: 200, body: { status: 'ignored', reason: `event=${eventType}` } };
  }

  const action = payload.action;
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return { status: 400, body: { error: 'Missing repository.full_name' } };
  }
  const log = buildLog(repoFullName);

  if (!['opened', 'labeled'].includes(action)) {
    return { status: 200, body: { status: 'ignored', reason: `action=${action}` } };
  }

  const manifest = registry.getManifest(repoFullName);
  if (!manifest && !live) {
    log(`[skip] no manifest at configs/${repoFullName}/manifest.yaml`);
    log('       set Gmail env vars to enable live introspection auto-onboarding');
    return {
      status: 202,
      body: { status: 'skipped', reason: 'manifest-not-found-and-introspection-deps-missing' },
    };
  }

  if (manifest && action === 'opened') {
    // Only act on 'opened' if the trigger_label is already on the issue. The
    // typical flow is: user creates issue (no labels) then adds trigger_label
    // — the 'labeled' event drives the pipeline. Accepting every 'opened'
    // event would race a second pipeline against the 'labeled' one.
    const labels: Array<{ name?: string }> = (payload.issue as any).labels ?? [];
    const hasTrigger = labels.some((l) => l?.name === manifest.trigger_label);
    if (!hasTrigger) {
      return {
        status: 200,
        body: {
          status: 'ignored',
          reason: `opened-without-trigger-label=${manifest.trigger_label}`,
        },
      };
    }
  }

  if (manifest && action === 'labeled') {
    const labelName = (payload as any).label?.name;
    // Only the trigger_label kicks off a pipeline run. The skip_pm_gate_label
    // is read from the issue's full label set during the pipeline run, so
    // adding it alone (or together with the trigger label) should NOT fire a
    // second pipeline. Previously we accepted both, which caused two parallel
    // pipelines to stomp on the same workspace when users added both labels.
    if (labelName !== manifest.trigger_label) {
      return {
        status: 200,
        body: { status: 'ignored', reason: `label=${labelName}-not-trigger` },
      };
    }
  }

  log(`[issue#${payload.issue.number}] ${action}: "${payload.issue.title}"`);

  let adapter;
  try {
    adapter = await loadAdapter(repoFullName, {
      repoRoot: env.REPO_ROOT,
      runIntrospection: live
        ? (async (repo, pmEmail, forkOrg, opts) => {
            log(`[introspection] starting auto-onboarding for ${repo}`);
            return live.runIntrospection(repo, pmEmail, forkOrg, opts);
          })
        : (async () => {
            throw new Error(
              `No manifest for ${repoFullName} and Gmail/introspection deps not configured.`
            );
          }),
    });
  } catch (err: any) {
    log(`[error] adapter load failed: ${err?.message ?? err}`);
    return { status: 500, body: { status: 'error', reason: 'adapter-load-failed' } };
  }

  const finalManifest = registry.getManifest(repoFullName);
  if (!finalManifest) {
    log(`[error] manifest still missing after adapter load`);
    return { status: 500, body: { status: 'error', reason: 'manifest-missing-post-onboarding' } };
  }

  const labelName = action === 'labeled' ? (payload as any).label?.name : undefined;
  const runKey = `${repoFullName}#${payload.issue.number}`;
  const acquired = runStateStore.acquireRun({
    key: runKey,
    repoFullName,
    issueNumber: payload.issue.number,
    action,
    ...(labelName ? { labelName } : {}),
    instanceId:
      process.env.RENDER_INSTANCE_ID ||
      process.env.RENDER_SERVICE_ID ||
      process.env.HOSTNAME,
  });
  if (!acquired.acquired) {
    log(
      `[pipeline] duplicate trigger ignored for ${runKey}; existing run started at ${acquired.record.startedAt}`
    );
    return {
      status: 202,
      body: {
        status: 'already-running',
        message: 'pipeline already running for this issue',
        runKey,
        startedAt: acquired.record.startedAt,
      },
    };
  }

  void runPipeline({
    payload,
    manifest: finalManifest,
    adapter,
    deps: {
      token: env.GITHUB_TOKEN,
      forkOrg: env.DEFAULT_FORK_ORG,
      workspaceRoot: env.WORKSPACE_ROOT,
      authorName: env.GIT_AUTHOR_NAME,
      authorEmail: env.GIT_AUTHOR_EMAIL,
      log,
      live: live ?? undefined,
    },
  })
    .then((result) => {
      runStateStore.completeRun(runKey, 'completed', { result });
      log(`[pipeline] complete: ${JSON.stringify(result)}`);
    })
    .catch((err: any) => {
      runStateStore.completeRun(runKey, 'failed', {
        error: err?.stack ?? err?.message ?? String(err),
      });
      log(`[pipeline] FATAL: ${err?.message ?? err}`);
      if (err?.stack) log(err.stack);
    })
    .finally(async () => {
      try {
        await getTracer().flush();
      } catch (err: any) {
        log(`[pipeline] tracer flush failed: ${err?.message ?? err}`);
      }
    });

  return {
    status: 202,
    body: { status: 'accepted', message: 'pipeline running in background; see server logs' },
  };
}

async function startServer(): Promise<void> {
  const env = loadEnv();
  const baseLog = (msg: string) => {
    const ts = new Date().toISOString();
    // eslint-disable-next-line no-console
    console.log(`${ts} [server] ${msg}`);
  };

  const contracts = getObservabilityAdapterContracts();
  for (const contract of contracts) {
    baseLog(
      `[observability] adapter=${contract.adapter} requested=${contract.requested} ` +
        `missing_env=${contract.missing_env.length > 0 ? contract.missing_env.join(',') : 'none'}`
    );
  }

  try {
    assertObservabilityConfigured();
    // Prime the tracer once at startup so configuration problems surface before
    // we accept webhook traffic.
    getTracer();
    const smoke = await runObservabilityStartupSmoke();
    const diagnostics = getObservabilityDiagnostics();
    for (const adapter of diagnostics) {
      baseLog(
        `[observability] adapter=${adapter.adapter} enabled=${adapter.enabled} ` +
          `connected=${adapter.connected === null ? 'unknown' : adapter.connected} ` +
          `sent=${adapter.delivery.sent} failed=${adapter.delivery.failed} dropped=${adapter.delivery.dropped}`
      );
    }
    for (const check of smoke) {
      baseLog(
        `[observability] telemetry_smoke adapter=${check.adapter} ` +
          `${check.ok ? 'connected' : 'failed'} (${check.detail})`
      );
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[fatal] ${err?.message ?? err}`);
    process.exit(1);
  }
  const registry = new FsManifestRegistry(env.REPO_ROOT);

  let gistStore: GistStateStore | undefined;
  if (env.GIST_ID) {
    gistStore = new GistStateStore(env.GIST_ID, env.GITHUB_TOKEN);
    await gistStore.initialize();
    baseLog(`[state] using GitHub Gist state store (gist=${env.GIST_ID})`);
  } else {
    baseLog(`[state] using file-backed state store (root=${env.STATE_ROOT})`);
  }

  const runStateStore = new FilePipelineRunStateStore(
    gistStore ? gistStore.namespace('pipeline-runs') : env.STATE_ROOT,
  );

  const live = buildLiveDeps(process.env, {
    token: env.GITHUB_TOKEN,
    stateRoot: env.STATE_ROOT,
    gistStore,
    log: baseLog,
    repoRoot: env.REPO_ROOT,
  });

  if (live) {
    baseLog(`Resend mail enabled (from=${live.monitoredEmail}, replyTo=${live.replyToBase}+<runId>@...)`);
  }

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          live: !!live,
          llm: {
            anthropic: !!process.env.ANTHROPIC_API_KEY,
            openrouter: !!process.env.OPENROUTER_API_KEY,
          },
          observability: {
            backend: process.env.OBSERVABILITY_BACKEND ?? 'none',
            adapters: getObservabilityDiagnostics(),
          },
        })
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/inbound') {
      if (!live) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'mail not configured' }));
        return;
      }
      const ichunks: Buffer[] = [];
      req.on('data', (c: Buffer) => ichunks.push(c));
      req.on('end', async () => {
        const raw = Buffer.concat(ichunks).toString('utf-8');
        const headers = {
          'svix-id': req.headers['svix-id'] as string | undefined,
          'svix-timestamp': req.headers['svix-timestamp'] as string | undefined,
          'svix-signature': req.headers['svix-signature'] as string | undefined,
        };
        try {
          const result = await live.dispatchInbound(raw, headers);
          res.writeHead(result.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.body));
        } catch (err: any) {
          // eslint-disable-next-line no-console
          console.error('[fatal] unhandled error in inbound handler:', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const eventType = (req.headers['x-github-event'] as string | undefined) ?? '';

      if (!verifySignature(body, signature, env.WEBHOOK_SECRET)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      let payload: IssueEvent;
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      try {
        const result = await processIssueEvent(
          payload,
          eventType,
          registry,
          env,
          live,
          runStateStore
        );
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } catch (err: any) {
        // eslint-disable-next-line no-console
        console.error('[fatal] unhandled error in webhook handler:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] oss-support-agent webhook listening on :${env.PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[server] repo root: ${path.resolve(env.REPO_ROOT)}`);
    // eslint-disable-next-line no-console
    console.log(`[server] workspace root: ${path.resolve(env.WORKSPACE_ROOT)}`);
    // eslint-disable-next-line no-console
    console.log(`[server] state root: ${path.resolve(env.STATE_ROOT)}`);
    // eslint-disable-next-line no-console
    console.log(`[server] fork org: ${env.DEFAULT_FORK_ORG}`);
    // eslint-disable-next-line no-console
    console.log(
      `[server] LLM: ${env.OPENROUTER_API_KEY ? 'OpenRouter (real)' : 'heuristic (no OPENROUTER_API_KEY)'}`
    );
    // eslint-disable-next-line no-console
    console.log(
      `[server] live deps: ${live ? `enabled (from=${live.monitoredEmail})` : 'disabled (skip-PM-gate path only)'}`
    );

    // Self-ping keepalive: prevent Render free-tier spin-down during long-running
    // LLM operations (investigator → planner → executor have no incoming requests).
    // RENDER_EXTERNAL_URL is auto-injected by Render; absent in local dev.
    const selfUrl = process.env.RENDER_EXTERNAL_URL;
    if (selfUrl) {
      const KEEPALIVE_MS = 10 * 60 * 1000; // 10 minutes
      const pingUrl = `${selfUrl}/healthz`;
      // eslint-disable-next-line no-console
      console.log(`[server] keepalive: pinging ${pingUrl} every ${KEEPALIVE_MS / 60_000} min`);
      const pinger = pingUrl.startsWith('https') ? https : http;
      setInterval(() => {
        pinger.get(pingUrl, (res) => {
          // eslint-disable-next-line no-console
          console.log(`[server] keepalive: ping ${res.statusCode}`);
          res.resume();
        }).on('error', (err) => {
          // eslint-disable-next-line no-console
          console.warn(`[server] keepalive: ping failed: ${err.message}`);
        });
      }, KEEPALIVE_MS).unref();
    }
  });
}

if (require.main === module) {
  void startServer().catch((err: any) => {
    // eslint-disable-next-line no-console
    console.error(`[fatal] ${err?.message ?? err}`);
    process.exit(1);
  });
}

export { startServer, processIssueEvent };
