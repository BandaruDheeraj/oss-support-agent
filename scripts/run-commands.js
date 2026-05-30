#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage() {
  // eslint-disable-next-line no-console
  console.error('Usage: node scripts/run-commands.js <commands.json> [output.json]');
  process.exit(2);
}

function isThenable(v) {
  return v && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';
}

function readJson(p) {
  const raw = fs.readFileSync(p, 'utf8');
  return JSON.parse(raw);
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function getShellCommand(command) {
  if (process.platform === 'win32') {
    // cmd.exe has different quoting rules; keep this minimal.
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { file: 'bash', args: ['-lc', command] };
}

function runOne(command, cwd) {
  return new Promise((resolve) => {
    const shell = getShellCommand(command);

    const child = spawn(shell.file, shell.args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      stderr += `\n[run-commands] spawn error: ${err && err.message ? err.message : String(err)}`;
      resolve({ command, exitCode: 1, stdout, stderr });
    });

    child.on('close', (code) => {
      resolve({ command, exitCode: typeof code === 'number' ? code : 1, stdout, stderr });
    });
  });
}

async function main() {
  const commandsPath = process.argv[2];
  const outputPath = process.argv[3] || 'sandbox-output.json';
  if (!commandsPath) usage();

  const commands = readJson(commandsPath);
  if (!Array.isArray(commands) || !commands.every((c) => typeof c === 'string')) {
    throw new Error('commands.json must be a JSON array of strings');
  }

  const cwd = process.cwd();
  const results = [];

  for (const cmd of commands) {
    // eslint-disable-next-line no-console
    console.log(`[sandbox] $ ${cmd}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await runOne(cmd, cwd);
    results.push(r);

    // Persist after each command so we still have partial output on failure.
    writeJson(outputPath, results);

    if (r.exitCode !== 0) {
      // eslint-disable-next-line no-console
      console.error(`[sandbox] command failed with exitCode=${r.exitCode}: ${cmd}`);
      process.exit(r.exitCode);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[sandbox] all commands passed');
  process.exit(0);
}

Promise.resolve()
  .then(main)
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
