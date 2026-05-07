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
import * as path from 'path';

import { verifySignature } from '../core/webhook/signature';
import type { IssueEvent } from '../core/webhook/types';
import { loadAdapter } from '../core/adapter-loader';
import { runTriage } from '../core/agents/triage';
import type { TriageInput } from '../core/agents/triage-types';
import { createDefaultTriageClassifier } from '../core/llm/openrouter-triage-classifier';

import { FsManifestRegistry } from './clients/manifest-registry';
import { GitHubIssueCommenter } from './clients/github-rest';

interface RequiredEnv {
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
}

interface OptionalEnv {
  PORT: number;
  OPENROUTER_API_KEY: string | undefined;
  REPO_ROOT: string;
}

function loadEnv(): RequiredEnv & OptionalEnv {
  const required = ['GITHUB_TOKEN', 'WEBHOOK_SECRET'];
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
    PORT: port,
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    REPO_ROOT: process.env.REPO_ROOT ?? process.cwd(),
  };
}

function buildTriageInput(
  payload: IssueEvent,
  triggerLabel: string | undefined,
  skipPmGateLabel: string | undefined
): TriageInput {
  const labels = (payload.issue.labels ?? []).map((l) => l.name);
  return {
    number: payload.issue.number,
    title: payload.issue.title ?? '',
    body: payload.issue.body ?? '',
    labels,
    author: payload.issue.user?.login ?? 'unknown',
    repoTree: [],
    hasSkipPmGate: !!skipPmGateLabel && labels.includes(skipPmGateLabel),
    url: `https://github.com/${payload.repository.full_name}/issues/${payload.issue.number}`,
  };
}

async function processIssueEvent(
  payload: IssueEvent,
  eventType: string,
  registry: FsManifestRegistry,
  commenter: GitHubIssueCommenter,
  repoRoot: string
): Promise<{ status: number; body: any }> {
  if (eventType !== 'issues') {
    return { status: 200, body: { status: 'ignored', reason: `event=${eventType}` } };
  }

  const action = payload.action;
  const repoFullName = payload.repository?.full_name;
  if (!repoFullName) {
    return { status: 400, body: { error: 'Missing repository.full_name' } };
  }

  if (!['opened', 'labeled'].includes(action)) {
    return { status: 200, body: { status: 'ignored', reason: `action=${action}` } };
  }

  const manifest = registry.getManifest(repoFullName);
  if (!manifest) {
    log(repoFullName, `[skip] no manifest at configs/${repoFullName}/manifest.yaml`);
    log(repoFullName, '       run introspection offline before live mode can process this repo');
    return {
      status: 202,
      body: { status: 'skipped', reason: 'manifest-not-found-introspection-not-wired' },
    };
  }

  // Honour trigger_label / skip_pm_gate_label gating for "labeled" events.
  if (action === 'labeled') {
    const labelName = (payload as any).label?.name;
    if (
      labelName !== manifest.trigger_label &&
      labelName !== manifest.skip_pm_gate_label
    ) {
      return {
        status: 200,
        body: { status: 'ignored', reason: `label=${labelName}-not-trigger` },
      };
    }
  }

  log(repoFullName, `[issue#${payload.issue.number}] ${action}: "${payload.issue.title}"`);

  // Load the adapter. Block introspection in live mode.
  let adapter;
  try {
    adapter = await loadAdapter(repoFullName, {
      repoRoot,
      runIntrospection: async () => {
        throw new Error(
          `Live mode does not run introspection. Run it offline for ${repoFullName} first.`
        );
      },
    });
  } catch (err: any) {
    log(repoFullName, `[error] adapter load failed: ${err?.message ?? err}`);
    return { status: 500, body: { status: 'error', reason: 'adapter-load-failed' } };
  }

  // Triage.
  const input = buildTriageInput(payload, manifest.trigger_label, manifest.skip_pm_gate_label);
  const classifier = createDefaultTriageClassifier();

  let routing;
  try {
    routing = await runTriage(repoFullName, payload.issue.number, input, adapter, commenter, {
      typeClassifier: classifier,
    });
  } catch (err: any) {
    log(repoFullName, `[error] triage failed: ${err?.message ?? err}`);
    return { status: 500, body: { status: 'error', reason: 'triage-failed' } };
  }

  log(
    repoFullName,
    `[triage] action=${routing.action} type=${routing.result.issueType} ` +
      `module=${routing.result.affectedModule} confidence=${routing.result.confidence.toFixed(2)}`
  );

  // Phase 1 stops here. Subsequent stages are TODO.
  log(repoFullName, '[todo] PM agent / fork / fix / build / sandbox / eval / PR — not yet wired in live mode');

  return {
    status: 202,
    body: {
      status: 'accepted',
      action: routing.action,
      issueType: routing.result.issueType,
      affectedModule: routing.result.affectedModule,
      confidence: routing.result.confidence,
    },
  };
}

function log(repoFullName: string, msg: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`${ts} ${repoFullName} ${msg}`);
}

function startServer(): void {
  const env = loadEnv();
  const registry = new FsManifestRegistry(env.REPO_ROOT);
  const commenter = new GitHubIssueCommenter(env.GITHUB_TOKEN);

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
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
          commenter,
          env.REPO_ROOT
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
    console.log(
      `[server] LLM: ${env.OPENROUTER_API_KEY ? 'OpenRouter (real)' : 'heuristic (no OPENROUTER_API_KEY)'}`
    );
  });
}

if (require.main === module) {
  startServer();
}

export { startServer, processIssueEvent };
