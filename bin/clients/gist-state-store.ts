/**
 * GitHub Gist-backed persistent state store.
 *
 * Keeps an in-memory cache of all state, pre-loaded from the gist on startup.
 * Reads are synchronous (from cache). Writes update the cache immediately and
 * queue a background PATCH to the gist — fire-and-forget, safe for single-instance.
 *
 * Each namespace maps to one file in the gist (e.g. "pipeline-runs.json").
 */

import * as https from 'https';

export interface StorageBackend {
  save(key: string, value: unknown): void;
  load<T>(key: string): T | null;
  remove(key: string): void;
}

export class FileBackend implements StorageBackend {
  private readonly fs = require('fs') as typeof import('fs');
  private readonly path = require('path') as typeof import('path');

  constructor(private readonly dir: string) {
    this.fs.mkdirSync(dir, { recursive: true });
  }

  save(key: string, value: unknown): void {
    this.fs.writeFileSync(
      this.path.join(this.dir, `${key}.json`),
      JSON.stringify(value, null, 2),
      'utf-8',
    );
  }

  load<T>(key: string): T | null {
    const f = this.path.join(this.dir, `${key}.json`);
    if (!this.fs.existsSync(f)) return null;
    try {
      return JSON.parse(this.fs.readFileSync(f, 'utf-8')) as T;
    } catch {
      return null;
    }
  }

  remove(key: string): void {
    const f = this.path.join(this.dir, `${key}.json`);
    if (this.fs.existsSync(f)) this.fs.unlinkSync(f);
  }
}

class GistNamespaceBackend implements StorageBackend {
  constructor(
    private readonly store: GistStateStore,
    private readonly namespace: string,
  ) {}

  save(key: string, value: unknown): void {
    this.store.set(this.namespace, key, value);
  }

  load<T>(key: string): T | null {
    return this.store.get<T>(this.namespace, key);
  }

  remove(key: string): void {
    this.store.delete(this.namespace, key);
  }
}

interface GistResponse {
  files: Record<string, { content?: string }>;
  message?: string;
}

export class GistStateStore {
  private readonly data = new Map<string, Map<string, unknown>>();
  private writeQueue = Promise.resolve();

  constructor(
    private readonly gistId: string,
    private readonly token: string,
  ) {}

  async initialize(): Promise<void> {
    const gist = await this.request<GistResponse>('GET', `/gists/${this.gistId}`);
    if (gist.message) {
      throw new Error(`Gist fetch failed: ${gist.message}`);
    }
    for (const [filename, file] of Object.entries(gist.files)) {
      if (!filename.endsWith('.json')) continue;
      const ns = filename.slice(0, -5); // strip .json
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(file.content ?? '{}');
      } catch {
        // start fresh for this namespace if content is invalid
      }
      this.data.set(ns, new Map(Object.entries(parsed)));
    }
  }

  namespace(name: string): StorageBackend {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return new GistNamespaceBackend(this, name);
  }

  set(namespace: string, key: string, value: unknown): void {
    this.ns(namespace).set(key, value);
    this.scheduleWrite(namespace);
  }

  get<T>(namespace: string, key: string): T | null {
    return (this.ns(namespace).get(key) as T) ?? null;
  }

  delete(namespace: string, key: string): void {
    this.ns(namespace).delete(key);
    this.scheduleWrite(namespace);
  }

  private ns(name: string): Map<string, unknown> {
    if (!this.data.has(name)) this.data.set(name, new Map());
    return this.data.get(name)!;
  }

  private scheduleWrite(namespace: string): void {
    this.writeQueue = this.writeQueue.then(() =>
      this.flushNamespace(namespace).catch((err) =>
        // eslint-disable-next-line no-console
        console.error(`[gist-store] write failed for namespace "${namespace}":`, err),
      ),
    );
  }

  private async flushNamespace(namespace: string): Promise<void> {
    const content = JSON.stringify(Object.fromEntries(this.ns(namespace)), null, 2);
    await this.request('PATCH', `/gists/${this.gistId}`, {
      files: { [`${namespace}.json`]: { content } },
    });
  }

  private request<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          hostname: 'api.github.com',
          path: apiPath,
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'User-Agent': 'oss-support-agent/1.0',
            Accept: 'application/vnd.github.v3+json',
            ...(payload
              ? {
                  'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(payload),
                }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              resolve(JSON.parse(text) as T);
            } catch {
              reject(
                new Error(
                  `Gist API non-JSON response (${res.statusCode}): ${text.slice(0, 200)}`,
                ),
              );
            }
          });
        },
      );
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
}
