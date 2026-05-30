#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const http = require('http');
const https = require('https');

function usage() {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/start-services.js <services.json>');
  process.exit(2);
}

function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpGet(url) {
  const lib = url.startsWith('https:') ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.get(url, (res) => {
      const ok = res.statusCode && res.statusCode >= 200 && res.statusCode < 500;
      // Drain response.
      res.resume();
      resolve({ ok, statusCode: res.statusCode || 0 });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error('timeout'));
    });
  });
}

async function waitForHealth(url, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const res = await httpGet(url);
      if (res.ok) return;
    } catch {
      // ignore and retry
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(1000);
  }
  throw new Error(`Service did not become healthy within ${timeoutMs}ms: ${url}`);
}

function docker(args) {
  const r = spawnSync('docker', args, { stdio: 'inherit' });
  if (r.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed with exit code ${r.status}`);
  }
}

async function main() {
  const servicesPath = process.argv[2];
  if (!servicesPath) usage();

  const services = readJson(servicesPath);
  if (!Array.isArray(services)) {
    throw new Error('services.json must be a JSON array');
  }

  for (const svc of services) {
    if (!svc || typeof svc !== 'object') {
      throw new Error('Each service entry must be an object');
    }
    const { name, image, ports, env, healthCheckUrl } = svc;
    if (typeof name !== 'string' || name.length === 0) throw new Error('Service.name is required');
    if (typeof image !== 'string' || image.length === 0) throw new Error('Service.image is required');

    const args = ['run', '-d', '--rm', '--name', `sandbox-${name}`];

    if (Array.isArray(ports)) {
      for (const p of ports) {
        if (!p || typeof p !== 'object') continue;
        if (typeof p.hostPort === 'number' && typeof p.containerPort === 'number') {
          args.push('-p', `${p.hostPort}:${p.containerPort}`);
        }
      }
    }

    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        args.push('-e', `${k}=${String(v)}`);
      }
    }

    args.push(image);

    // eslint-disable-next-line no-console
    console.log(`[sandbox] starting service ${name} (${image})`);
    docker(args);

    if (typeof healthCheckUrl === 'string' && healthCheckUrl.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[sandbox] waiting for healthCheckUrl: ${healthCheckUrl}`);
      await waitForHealth(healthCheckUrl, 120_000);
    }
  }
}

Promise.resolve()
  .then(main)
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
