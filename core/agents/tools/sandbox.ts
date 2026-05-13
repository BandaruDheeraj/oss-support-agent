/**
 * Sandbox-tier tools.
 *
 * No `run_shell`. Typed verbs only. The orchestrator's SandboxHandle decides
 * how each verb is realised (e.g. via GitHub Actions workflow_dispatch in
 * production, or a local subprocess shim in tests).
 */

import { z } from 'zod';
import type { ToolDef } from './types';
import { asHandles } from './handles';

const RunRepro = z.object({}).strict();
export const runRepro: ToolDef<z.infer<typeof RunRepro>, unknown> = {
  name: 'run_repro',
  tier: 'sandbox',
  description:
    'Run the canonical repro test. Returns exit code + stdout/stderr. Required to verify a fix or to confirm a repro reproduces.',
  parameters: RunRepro,
  async execute(_args, ctx) {
    return asHandles(ctx.handles).sandbox.runRepro();
  },
};

const RunTests = z.object({ scopePath: z.string().optional() }).strict();
export const runTests: ToolDef<z.infer<typeof RunTests>, unknown> = {
  name: 'run_tests',
  tier: 'sandbox',
  description: 'Run the broader test suite, optionally scoped to a path.',
  parameters: RunTests,
  async execute({ scopePath }, ctx) {
    return asHandles(ctx.handles).sandbox.runTests(scopePath);
  },
};

const RunPython = z
  .object({
    snippet: z.string().min(1).max(8000),
    env: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export const runPython: ToolDef<z.infer<typeof RunPython>, unknown> = {
  name: 'run_python',
  tier: 'sandbox',
  description: 'Run a bounded python snippet in the sandbox. No shell. For quick probes only.',
  parameters: RunPython,
  async execute({ snippet, env }, ctx) {
    return asHandles(ctx.handles).sandbox.runPython(snippet, env);
  },
};

const PipInstall = z.object({ spec: z.string().min(1) }).strict();
export const pipInstall: ToolDef<z.infer<typeof PipInstall>, unknown> = {
  name: 'pip_install',
  tier: 'sandbox',
  description: 'Install a python package (`pip install <spec>`). Use when run_repro reports ModuleNotFoundError.',
  parameters: PipInstall,
  async execute({ spec }, ctx) {
    return asHandles(ctx.handles).sandbox.pipInstall(spec);
  },
};

const PythonModuleCheck = z.object({ name: z.string().min(1) }).strict();
export const pythonModuleCheck: ToolDef<z.infer<typeof PythonModuleCheck>, unknown> = {
  name: 'python_module_check',
  tier: 'sandbox',
  description: 'Check whether a python module is importable in the sandbox; returns version when available.',
  parameters: PythonModuleCheck,
  async execute({ name }, ctx) {
    return asHandles(ctx.handles).sandbox.pythonModuleCheck(name);
  },
};

const ListPackages = z.object({}).strict();
export const listPackages: ToolDef<z.infer<typeof ListPackages>, unknown> = {
  name: 'list_packages',
  tier: 'sandbox',
  description: 'List currently installed python packages (name + version).',
  parameters: ListPackages,
  async execute(_args, ctx) {
    return { packages: await asHandles(ctx.handles).sandbox.listPackages() };
  },
};

export const SANDBOX_TOOLS = [runRepro, runTests, runPython, pipInstall, pythonModuleCheck, listPackages] as const;
