import * as http from 'http';
import { verifySignature } from './signature';
import { routeEvent, ManifestRegistry } from './router';
import { IssueEvent, WebhookResult } from './types';
import { StateMachine } from '../orchestrator/state-machine';

export interface WebhookServerOptions {
  port: number;
  secret: string;
  registry: ManifestRegistry;
  stateMachine: StateMachine;
}

/**
 * Create the webhook HTTP server.
 * Accepts GitHub webhook POSTs, verifies HMAC signature, and routes issue events.
 */
export function createWebhookServer(options: WebhookServerOptions): http.Server {
  const { secret, registry, stateMachine } = options;

  const server = http.createServer((req, res) => {
    // Only accept POST to /webhook
    if (req.method !== 'POST' || req.url !== '/webhook') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      const eventType = req.headers['x-github-event'] as string | undefined;

      // Verify HMAC signature
      if (!verifySignature(body, signature, secret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid signature' }));
        return;
      }

      if (!eventType) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing X-GitHub-Event header' }));
        return;
      }

      // Parse payload
      let payload: IssueEvent;
      try {
        payload = JSON.parse(body.toString('utf-8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      // Route the event
      const result: WebhookResult = routeEvent(payload, eventType, registry, stateMachine);

      // Return 202 Accepted for accepted/skipped, 200 for ignored
      const statusCode = result.status === 'ignored' ? 200 : 202;
      res.writeHead(statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });

  return server;
}
