// Verified clean: triggerWorkflowDispatch, createSandboxConfig, verifyDispatchRefs
// have no call sites outside SandboxSession as of 4cf4ecd.
import type { Manifest } from './manifest/types';
import type { SandboxCommandResult } from './adapter.interface';
import {
  SANDBOX_WORKFLOW_FILE,
  type ActionsClient,
  type WorkflowRun,
} from './sandbox-types';

export interface PackageVersion {
  name: string;
  version: string;
  replaySpec?: string;
}

export interface InstallSpec {
  semanticConventionsPath: string;
  instrumentationCorePath: string;
  instrumentationPackagePath: string;
  thirdPartyDeps: string[];
  importVerification: {
    modulePath: string;
    className: string;
  };
}

export interface Recipe {
  commands: string[];
  sentinel?: string;
  suspectPath?: string;
  suspectPathNeedles?: string[];
}

export interface WorkflowDispatchRequest {
  workflowId: string;
  inputs: Record<string, string>;
  timeoutMins?: number;
  requireSetup?: boolean;
}

export interface GitFileProbeResult {
  ok: boolean;
  status: number;
  content?: string;
  error?: string;
}

export interface GitClient {
  getDefaultBranch(repoFullName: string): Promise<string>;
  getBranchSha(repoFullName: string, branch: string): Promise<string | null>;
  createBranch(repoFullName: string, branch: string, sha: string): Promise<void>;
  pushPendingChanges(repoFullName: string, branch: string): Promise<void>;
  getFileContents(repoFullName: string, path: string, ref: string): Promise<GitFileProbeResult>;
}

export type SandboxPhase = 'branch' | 'workflow' | 'setup';

export type SandboxPhaseSuccess =
  | { ok: true; phase: 'branch'; sha: string }
  | { ok: true; phase: 'workflow' }
  | { ok: true; phase: 'setup'; installManifest: PackageVersion[] };

export interface SandboxPhaseFailure {
  ok: false;
  phase: SandboxPhase;
  reason: string;
  diagnostics?: Record<string, unknown>;
  failedStep?: number;
  stdout?: string;
  stderr?: string;
}

export type SandboxPhaseResult = SandboxPhaseSuccess | SandboxPhaseFailure;

export type SandboxDispatchResult =
  | {
      ok: true;
      runId: number;
      runUrl: string;
      conclusion: string | null;
      stepOutcomes: Array<{ command: string; exitCode: number | null }>;
      stdout: string;
      stderr: string;
      rawLogs: string;
      exitCode: number | null;
    }
  | {
      ok: false;
      reason: 'workflow_not_found' | 'ref_not_found' | 'dispatch_failed';
      diagnostics: Record<string, unknown>;
    };

export interface SandboxResult {
  ok: boolean;
  reproStatus: 'failing' | 'passing' | 'errored' | 'not_executed';
  failureOutput: string;
  sentinelMatched: boolean;
  suspectPathHit: boolean;
  installManifest: PackageVersion[];
  phaseFailures: SandboxPhaseFailure[];
  rawLogs: string;
}

export class SandboxConfigError extends Error {
  public readonly fields: ReadonlyArray<{ field: string; received: unknown }>;

  constructor(fields: Array<{ field: string; received: unknown }>) {
    super(
      `SandboxSession construction failed: ${fields
        .map((f) => `${f.field}=${JSON.stringify(f.received)}`)
        .join(', ')}`
    );
    this.name = 'SandboxConfigError';
    this.fields = fields;
  }
}

type CommandExecution =
  | {
      ok: true;
      runId: number;
      conclusion: string | null;
      exitCode: number | null;
      stdout: string;
      stderr: string;
      rawLogs: string;
      commands?: SandboxCommandResult[];
    }
  | {
      ok: false;
      reason: 'workflow_not_found' | 'ref_not_found' | 'dispatch_failed';
      diagnostics: Record<string, unknown>;
      stdout: string;
      stderr: string;
      rawLogs: string;
      exitCode: number | null;
      commands?: SandboxCommandResult[];
    };

export class SandboxSession {
  private readonly manifest: Manifest;
  private readonly targetRepo: string;
  private readonly sandboxWorkflowRepo: string;
  private readonly sandboxWorkflowRef: string;
  private readonly branch: string;
  private readonly issueNumber: number;
  private readonly timeoutMins: number;
  private readonly actionsClient: ActionsClient;
  private readonly gitClient: GitClient;

  private readonly phaseResults: Partial<Record<SandboxPhase, SandboxPhaseResult>> = {};
  private installManifestState: PackageVersion[] = [];
  private replayInstallCommands: string[] = [];
  private lastDispatch:
    | {
        ok: boolean;
        exitCode: number | null;
        rawLogs: string;
        failureOutput: string;
        sentinelMatched: boolean;
        suspectPathHit: boolean;
      }
    | null = null;

  constructor(params: {
    manifest: Manifest;
    targetRepo: string;
    sandboxWorkflowRepo: string;
    sandboxWorkflowRef: string;
    branch: string;
    issueNumber: number;
    timeoutMins: number;
    actionsClient: ActionsClient;
    gitClient: GitClient;
  }) {
    const errors: Array<{ field: string; received: unknown }> = [];

    if (!isOwnerRepo(params.targetRepo)) {
      errors.push({ field: 'targetRepo', received: params.targetRepo });
    }
    if (!isOwnerRepo(params.sandboxWorkflowRepo)) {
      errors.push({ field: 'sandboxWorkflowRepo', received: params.sandboxWorkflowRepo });
    }
    if (
      typeof params.sandboxWorkflowRepo === 'string' &&
      typeof params.targetRepo === 'string' &&
      params.sandboxWorkflowRepo === params.targetRepo
    ) {
      errors.push({
        field: 'sandboxWorkflowRepo',
        received:
          'sandboxWorkflowRepo must be the support agent repo, not the target repo — this would cause a 404 on dispatch',
      });
    }
    if (typeof params.branch !== 'string' || params.branch.trim().length === 0) {
      errors.push({ field: 'branch', received: params.branch });
    }
    if (
      typeof params.timeoutMins !== 'number' ||
      !Number.isFinite(params.timeoutMins) ||
      params.timeoutMins <= 0
    ) {
      errors.push({ field: 'timeoutMins', received: params.timeoutMins });
    }

    if (errors.length > 0) {
      throw new SandboxConfigError(errors);
    }

    this.manifest = params.manifest;
    this.targetRepo = params.targetRepo;
    this.sandboxWorkflowRepo = params.sandboxWorkflowRepo;
    this.sandboxWorkflowRef = params.sandboxWorkflowRef;
    this.branch = params.branch;
    this.issueNumber = params.issueNumber;
    this.timeoutMins = params.timeoutMins;
    this.actionsClient = params.actionsClient;
    this.gitClient = params.gitClient;
  }

  async verifyAndPushBranch(): Promise<SandboxPhaseResult> {
    const cached = this.phaseResults.branch;
    if (cached?.ok) {
      return cached;
    }

    try {
      let branchSha = await this.gitClient.getBranchSha(this.targetRepo, this.branch);
      if (!branchSha) {
        const defaultBranch = await this.gitClient.getDefaultBranch(this.targetRepo);
        const baseSha = await this.gitClient.getBranchSha(this.targetRepo, defaultBranch);
        if (!baseSha) {
          return this.recordPhaseResult({
            ok: false,
            phase: 'branch',
            reason: 'branch_push_unconfirmed',
            diagnostics: {
              branch: this.branch,
              targetRepo: this.targetRepo,
              defaultBranch,
              attemptsExhausted: true,
              error: `missing base SHA for default branch ${defaultBranch}`,
            },
          });
        }
        await this.gitClient.createBranch(this.targetRepo, this.branch, baseSha);
      }

      await this.gitClient.pushPendingChanges(this.targetRepo, this.branch);

      const maxAttempts = 5;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        branchSha = await this.gitClient.getBranchSha(this.targetRepo, this.branch);
        if (branchSha) {
          return this.recordPhaseResult({
            ok: true,
            phase: 'branch',
            sha: branchSha,
          });
        }
        if (attempt < maxAttempts) {
          await sleep(2_000);
        }
      }

      return this.recordPhaseResult({
        ok: false,
        phase: 'branch',
        reason: 'branch_push_unconfirmed',
        diagnostics: {
          branch: this.branch,
          targetRepo: this.targetRepo,
          attemptsExhausted: true,
        },
      });
    } catch (err) {
      return this.recordPhaseResult({
        ok: false,
        phase: 'branch',
        reason: 'branch_push_unconfirmed',
        diagnostics: {
          branch: this.branch,
          targetRepo: this.targetRepo,
          attemptsExhausted: true,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async verifyWorkflowReachability(workflowId: string = SANDBOX_WORKFLOW_FILE): Promise<SandboxPhaseResult> {
    try {
      const probe = await this.gitClient.getFileContents(
        this.sandboxWorkflowRepo,
        `.github/workflows/${workflowId}`,
        this.sandboxWorkflowRef
      );
      if (!probe.ok) {
        return this.recordPhaseResult({
          ok: false,
          phase: 'workflow',
          reason: 'workflow_unreachable',
          diagnostics: {
            sandboxWorkflowRepo: this.sandboxWorkflowRepo,
            sandboxWorkflowRef: this.sandboxWorkflowRef,
            workflowId,
            httpStatus: probe.status,
            error: probe.error ?? null,
          },
        });
      }

      return this.recordPhaseResult({ ok: true, phase: 'workflow' });
    } catch (err) {
      return this.recordPhaseResult({
        ok: false,
        phase: 'workflow',
        reason: 'workflow_unreachable',
        diagnostics: {
          sandboxWorkflowRepo: this.sandboxWorkflowRepo,
          sandboxWorkflowRef: this.sandboxWorkflowRef,
          workflowId,
          httpStatus: null,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  async dispatchWorkflow(request: WorkflowDispatchRequest): Promise<SandboxDispatchResult> {
    this.assertPhaseSucceeded('branch', 'verifyAndPushBranch');
    this.assertPhaseSucceeded('workflow', 'verifyWorkflowReachability');
    if (request.requireSetup) {
      this.assertPhaseSucceeded('setup', 'setupDependencies');
    }

    if (this.sandboxWorkflowRepo === this.targetRepo) {
      throw new Error(
        'SandboxSession.dispatch invariant violated: sandbox.yml lives in the support agent repo; dispatching to targetRepo would cause a 404.'
      );
    }

    const run = await this.executeWorkflowDispatch(
      request.workflowId,
      request.inputs,
      request.timeoutMins ?? this.timeoutMins
    );
    if (!run.ok) {
      if (run.reason === 'workflow_not_found' || run.reason === 'ref_not_found') {
        return {
          ok: false,
          reason: run.reason,
          diagnostics: run.diagnostics,
        };
      }
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: run.diagnostics,
      };
    }

    return {
      ok: true,
      runId: run.runId,
      runUrl: `https://github.com/${this.sandboxWorkflowRepo}/actions/runs/${run.runId}`,
      conclusion: run.conclusion,
      stepOutcomes: [],
      stdout: run.stdout,
      stderr: run.stderr,
      rawLogs: run.rawLogs,
      exitCode: run.exitCode,
    };
  }

  async setupDependencies(spec: InstallSpec): Promise<SandboxPhaseResult> {
    // All commands run in a SINGLE sandbox dispatch so each step sees the
    // packages installed by the previous ones. Dispatching one-per-run was
    // broken: every GHA run starts with a fresh container, so the import
    // verification step never saw the pip-installed packages.
    const commands = [
      `pip install -e ${spec.semanticConventionsPath}`,
      `pip install -e ${spec.instrumentationCorePath}`,
      `pip install -e ${spec.instrumentationPackagePath}`,
      `pip install ${spec.thirdPartyDeps.join(' ')}`.trim(),
      `python -c "from ${spec.importVerification.modulePath} import ${spec.importVerification.className}; print('import_ok')"`,
    ];

    const run = await this.runCommandInSandbox(commands);
    if (!run.ok) {
      return this.recordPhaseResult({
        ok: false,
        phase: 'setup',
        reason: 'dependency_setup_failed',
        stdout: run.stdout,
        stderr: run.stderr,
        diagnostics: run.diagnostics,
      });
    }

    // Find the first failed step from the per-command results in the artifact.
    const cmdResults = run.commands ?? [];
    for (let i = 0; i < commands.length; i += 1) {
      const failedStep = i + 1;
      const result = cmdResults[i];
      if (!result) continue;
      if (failedStep === 5) {
        const combined = `${result.stdout}\n${result.stderr}`;
        if (result.exitCode !== 0 || !combined.includes('import_ok')) {
          return this.recordPhaseResult({
            ok: false,
            phase: 'setup',
            reason: 'import_verification_failed',
            failedStep,
            stdout: result.stdout,
            stderr: result.stderr,
          });
        }
      } else if (result.exitCode !== 0) {
        return this.recordPhaseResult({
          ok: false,
          phase: 'setup',
          reason: 'dependency_setup_failed',
          failedStep,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
    }

    const installManifest = await this.collectInstallManifest(spec);
    return this.recordPhaseResult({
      ok: true,
      phase: 'setup',
      installManifest,
    });
  }

  recordReplayInstallCommand(command: string): void {
    const normalized = command.trim();
    if (!normalized) return;
    if (!this.replayInstallCommands.includes(normalized)) {
      this.replayInstallCommands.push(normalized);
    }
  }

  async dispatch(recipe: Recipe): Promise<SandboxDispatchResult> {
    this.assertPhaseSucceeded('branch', 'verifyAndPushBranch');
    this.assertPhaseSucceeded('workflow', 'verifyWorkflowReachability');
    this.assertPhaseSucceeded('setup', 'setupDependencies');

    if (this.sandboxWorkflowRepo === this.targetRepo) {
      throw new Error(
        'SandboxSession.dispatch invariant violated: sandbox.yml lives in the support agent repo; dispatching to targetRepo would cause a 404.'
      );
    }

    const replayCommands = this.buildInstallReplayCommands();
    const commandBatch = [...replayCommands, ...recipe.commands];
    const run = await this.runCommandInSandbox(commandBatch);
    if (!run.ok) {
      this.lastDispatch = {
        ok: false,
        exitCode: run.exitCode,
        rawLogs: run.rawLogs,
        failureOutput: run.stderr || run.stdout,
        sentinelMatched: false,
        suspectPathHit: false,
      };
      if (run.reason === 'workflow_not_found' || run.reason === 'ref_not_found') {
        return {
          ok: false,
          reason: run.reason,
          diagnostics: run.diagnostics,
        };
      }
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: run.diagnostics,
      };
    }

    const failureOutput = run.exitCode !== 0 ? run.stderr || run.stdout : '';
    const sentinelMatched = !!recipe.sentinel && failureOutput.includes(recipe.sentinel);
    const suspectNeedles = recipe.suspectPathNeedles && recipe.suspectPathNeedles.length > 0
      ? recipe.suspectPathNeedles
      : recipe.suspectPath
        ? [recipe.suspectPath]
        : [];
    const suspectPathHit = suspectNeedles.some((needle) => failureOutput.includes(needle));

    this.lastDispatch = {
      ok: true,
      exitCode: run.exitCode,
      rawLogs: run.rawLogs,
      failureOutput,
      sentinelMatched,
      suspectPathHit,
    };

    const stepOutcomes = run.commands
      ? run.commands.map((command) => ({
          command: command.command,
          exitCode: command.exitCode,
        }))
      : commandBatch.map((command) => ({
          command,
          exitCode: run.exitCode,
        }));

    return {
      ok: true,
      runId: run.runId,
      runUrl: `https://github.com/${this.sandboxWorkflowRepo}/actions/runs/${run.runId}`,
      conclusion: run.conclusion,
      stepOutcomes,
      stdout: run.stdout,
      stderr: run.stderr,
      rawLogs: run.rawLogs,
      exitCode: run.exitCode,
    };
  }

  result(): SandboxResult {
    const phaseFailures = this.getPhaseFailures();
    if (phaseFailures.length > 0) {
      return {
        ok: false,
        reproStatus: 'not_executed',
        failureOutput: '',
        sentinelMatched: false,
        suspectPathHit: false,
        installManifest: [...this.installManifestState],
        phaseFailures,
        rawLogs: this.lastDispatch?.rawLogs ?? '',
      };
    }

    if (!this.lastDispatch) {
      return {
        ok: false,
        reproStatus: 'not_executed',
        failureOutput: '',
        sentinelMatched: false,
        suspectPathHit: false,
        installManifest: [...this.installManifestState],
        phaseFailures,
        rawLogs: '',
      };
    }

    if (!this.lastDispatch.ok) {
      return {
        ok: false,
        reproStatus: 'errored',
        failureOutput: this.lastDispatch.failureOutput,
        sentinelMatched: false,
        suspectPathHit: false,
        installManifest: [...this.installManifestState],
        phaseFailures,
        rawLogs: this.lastDispatch.rawLogs,
      };
    }

    const reproStatus = this.lastDispatch.exitCode === 0 ? 'passing' : 'failing';
    return {
      ok: true,
      reproStatus,
      failureOutput: this.lastDispatch.failureOutput,
      sentinelMatched: this.lastDispatch.sentinelMatched,
      suspectPathHit: this.lastDispatch.suspectPathHit,
      installManifest: [...this.installManifestState],
      phaseFailures,
      rawLogs: this.lastDispatch.rawLogs,
    };
  }

  private assertPhaseSucceeded(phase: SandboxPhase, methodName: string): void {
    const result = this.phaseResults[phase];
    if (!result || !result.ok) {
      throw new Error(
        `SandboxSession.dispatch requires ${methodName}() to return ok: true before dispatch.`
      );
    }
  }

  private recordPhaseResult(result: SandboxPhaseResult): SandboxPhaseResult {
    this.phaseResults[result.phase] = result;
    if (result.ok && result.phase === 'setup') {
      this.installManifestState = [...result.installManifest];
    }
    return result;
  }

  private getPhaseFailures(): SandboxPhaseFailure[] {
    return Object.values(this.phaseResults).filter(
      (result): result is SandboxPhaseFailure => !!result && !result.ok
    );
  }

  private buildInstallReplayCommands(): string[] {
    const commands: string[] = [];
    const seen = new Set<string>();
    for (const pkg of this.installManifestState) {
      const command = pkg.replaySpec
        ? `pip install ${pkg.replaySpec}`
        : pkg.version && pkg.version !== 'unknown'
          ? `pip install ${pkg.name}==${pkg.version}`
          : `pip install ${pkg.name}`;
      if (!seen.has(command)) {
        seen.add(command);
        commands.push(command);
      }
    }
    for (const replay of this.replayInstallCommands) {
      if (!seen.has(replay)) {
        seen.add(replay);
        commands.push(replay);
      }
    }
    return commands;
  }

  private buildWorkflowInputs(commands: string[]): Record<string, string> {
    return {
      repo_full_name: this.targetRepo,
      fork_clone_url: `https://github.com/${this.targetRepo}.git`,
      branch_name: this.branch,
      test_commands_b64: Buffer.from(JSON.stringify(commands), 'utf-8').toString('base64'),
      services_b64: Buffer.from('[]', 'utf-8').toString('base64'),
    };
  }

  private async executeWorkflowDispatch(
    workflowId: string,
    inputs: Record<string, string>,
    timeoutMins: number
  ): Promise<CommandExecution> {
    const createdAfter = new Date().toISOString();
    try {
      await this.actionsClient.triggerWorkflowDispatch(
        this.sandboxWorkflowRepo,
        workflowId,
        this.sandboxWorkflowRef,
        inputs
      );
    } catch (err) {
      const status = extractHttpStatus(err);
      if (status === 404) {
        return {
          ok: false,
          reason: 'workflow_not_found',
          diagnostics: {
            sandboxWorkflowRepo: this.sandboxWorkflowRepo,
            sandboxWorkflowRef: this.sandboxWorkflowRef,
            workflowId,
            httpStatus: 404,
          },
          stdout: '',
          stderr: '',
          rawLogs: '',
          exitCode: null,
        };
      }
      if (status === 422) {
        return {
          ok: false,
          reason: 'ref_not_found',
          diagnostics: {
            sandboxWorkflowRepo: this.sandboxWorkflowRepo,
            sandboxWorkflowRef: this.sandboxWorkflowRef,
            workflowId,
            httpStatus: 422,
          },
          stdout: '',
          stderr: '',
          rawLogs: '',
          exitCode: null,
        };
      }
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: {
          sandboxWorkflowRepo: this.sandboxWorkflowRepo,
          sandboxWorkflowRef: this.sandboxWorkflowRef,
          workflowId,
          error: err instanceof Error ? err.message : String(err),
        },
        stdout: '',
        stderr: '',
        rawLogs: '',
        exitCode: null,
      };
    }

    const workflowRun = await this.waitForRun(workflowId, createdAfter, timeoutMins);
    if (!workflowRun) {
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: {
          sandboxWorkflowRepo: this.sandboxWorkflowRepo,
          sandboxWorkflowRef: this.sandboxWorkflowRef,
          workflowId,
          error: 'workflow run did not appear after dispatch',
        },
        stdout: '',
        stderr: '',
        rawLogs: '',
        exitCode: null,
      };
    }

    const runStatus = await this.actionsClient.waitForWorkflowRun(
      this.sandboxWorkflowRepo,
      workflowRun.id,
      timeoutMins * 60 * 1_000
    );
    if (runStatus.timedOut) {
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: {
          sandboxWorkflowRepo: this.sandboxWorkflowRepo,
          sandboxWorkflowRef: this.sandboxWorkflowRef,
          workflowId,
          error: `workflow timed out after ${timeoutMins} minute(s)`,
          runId: workflowRun.id,
        },
        stdout: '',
        stderr: '',
        rawLogs: '',
        exitCode: null,
      };
    }

    try {
      const logs = await this.actionsClient.getWorkflowRunLogs(
        this.sandboxWorkflowRepo,
        workflowRun.id
      );
      const artifactCommands = await this.downloadSandboxOutputCommands(workflowRun.id);
      const commands = artifactCommands ?? logs.commands;
      const stdout = commands ? formatCommandStream(commands, 'stdout') : logs.stdout;
      const stderr = commands ? formatCommandStream(commands, 'stderr') : logs.stderr;
      const exitCode = commands ? exitCodeFromCommands(commands, logs.exitCode) : logs.exitCode;
      const rawLogs = commands
        ? formatCommandRawLogs(commands, logs.stdout, logs.stderr)
        : [logs.stdout, logs.stderr].filter((s) => s.length > 0).join('\n');
      return {
        ok: true,
        runId: workflowRun.id,
        conclusion: runStatus.conclusion,
        exitCode,
        stdout,
        stderr,
        rawLogs,
        ...(commands ? { commands } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        reason: 'dispatch_failed',
        diagnostics: {
          sandboxWorkflowRepo: this.sandboxWorkflowRepo,
          sandboxWorkflowRef: this.sandboxWorkflowRef,
          workflowId,
          runId: workflowRun.id,
          error: err instanceof Error ? err.message : String(err),
        },
        stdout: '',
        stderr: '',
        rawLogs: '',
        exitCode: null,
      };
    }
  }

  private async runCommandInSandbox(commands: string[]): Promise<CommandExecution> {
    const inputs = this.buildWorkflowInputs(commands);
    return this.executeWorkflowDispatch(
      SANDBOX_WORKFLOW_FILE,
      inputs,
      this.timeoutMins
    );
  }

  private async waitForRun(
    workflowId: string,
    createdAfter: string,
    timeoutMins: number
  ): Promise<WorkflowRun | null> {
    const maxWaitMs = Math.min(timeoutMins * 60 * 1_000, 60_000);
    const pollIntervalMs = 2_000;
    const started = Date.now();
    while (Date.now() - started < maxWaitMs) {
      const run = await this.actionsClient.getWorkflowRun(
        this.sandboxWorkflowRepo,
        workflowId,
        this.sandboxWorkflowRef,
        createdAfter
      );
      if (run) {
        return run;
      }
      await sleep(pollIntervalMs);
    }
    return null;
  }

  private async downloadSandboxOutputCommands(runId: number): Promise<SandboxCommandResult[] | null> {
    if (!this.actionsClient.downloadWorkflowRunArtifact) {
      return null;
    }

    const attempts = 5;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const raw = await this.actionsClient.downloadWorkflowRunArtifact(
        this.sandboxWorkflowRepo,
        runId,
        'sandbox-output'
      );
      if (raw) {
        return parseSandboxOutputArtifact(raw);
      }
      if (attempt < attempts) {
        await sleep(2_000);
      }
    }
    return null;
  }

  private async collectInstallManifest(spec: InstallSpec): Promise<PackageVersion[]> {
    const ordered = [
      {
        name: derivePackageName(spec.semanticConventionsPath),
        replaySpec: `-e ${spec.semanticConventionsPath}`,
      },
      {
        name: derivePackageName(spec.instrumentationCorePath),
        replaySpec: `-e ${spec.instrumentationCorePath}`,
      },
      {
        name: derivePackageName(spec.instrumentationPackagePath),
        replaySpec: `-e ${spec.instrumentationPackagePath}`,
      },
      ...spec.thirdPartyDeps.map((dep) => ({
        name: dep,
        replaySpec: dep,
      })),
    ];

    const showTargets = Array.from(
      new Set(
        ordered
          .map((entry) => entry.name.trim())
          .filter((name) => name.length > 0)
      )
    );
    let versions = new Map<string, string>();
    if (showTargets.length > 0) {
      const run = await this.runCommandInSandbox([`pip show ${showTargets.join(' ')}`]);
      if (run.ok && run.exitCode === 0) {
        versions = new Map(
          parsePipShowOutput(run.stdout).map((pkg) => [pkg.name.toLowerCase(), pkg.version])
        );
      }
    }

    return ordered.map((entry) => ({
      name: entry.name,
      version: versions.get(entry.name.toLowerCase()) ?? 'unknown',
      replaySpec: entry.replaySpec,
    }));
  }
}

function parseSandboxOutputArtifact(raw: string): SandboxCommandResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `sandbox-output artifact was not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error('sandbox-output artifact must be a JSON array');
  }

  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`sandbox-output[${index}] must be an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row.command !== 'string' || row.command.trim().length === 0) {
      throw new Error(`sandbox-output[${index}].command must be a non-empty string`);
    }
    if (typeof row.exitCode !== 'number' || !Number.isFinite(row.exitCode)) {
      throw new Error(`sandbox-output[${index}].exitCode must be a finite number`);
    }
    return {
      command: row.command,
      exitCode: Math.trunc(row.exitCode),
      stdout: typeof row.stdout === 'string' ? row.stdout : '',
      stderr: typeof row.stderr === 'string' ? row.stderr : '',
    };
  });
}

function exitCodeFromCommands(
  commands: SandboxCommandResult[],
  fallback: number | null
): number | null {
  if (commands.length === 0) return fallback;
  const failed = commands.find((command) => command.exitCode !== 0);
  return failed ? failed.exitCode : commands[commands.length - 1]!.exitCode;
}

function formatCommandStream(
  commands: SandboxCommandResult[],
  field: 'stdout' | 'stderr'
): string {
  return commands
    .filter((command) => command[field].length > 0)
    .map((command) => `[sandbox] $ ${command.command}\n${command[field]}`)
    .join('\n');
}

function formatCommandRawLogs(
  commands: SandboxCommandResult[],
  workflowStdout: string,
  workflowStderr: string
): string {
  const commandLogs = commands
    .map((command) => {
      const chunks = [
        `[sandbox] $ ${command.command}`,
        command.stdout ? `stdout:\n${command.stdout}` : '',
        command.stderr ? `stderr:\n${command.stderr}` : '',
        `exitCode=${command.exitCode}`,
      ].filter((chunk) => chunk.length > 0);
      return chunks.join('\n');
    })
    .join('\n\n');
  const workflowLogs = [workflowStdout, workflowStderr]
    .filter((chunk) => chunk.length > 0)
    .join('\n');
  return [commandLogs, workflowLogs].filter((chunk) => chunk.length > 0).join('\n\n');
}

function parsePipShowOutput(stdout: string): PackageVersion[] {
  const out: PackageVersion[] = [];
  let name: string | null = null;
  let version: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const nameMatch = /^Name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      if (name && version) {
        out.push({ name, version });
      }
      name = nameMatch[1].trim();
      version = null;
      continue;
    }
    const versionMatch = /^Version:\s*(.+)$/.exec(line);
    if (versionMatch) {
      version = versionMatch[1].trim();
    }
  }
  if (name && version) {
    out.push({ name, version });
  }
  return out;
}

function derivePackageName(pathLike: string): string {
  const last = pathLike
    .trim()
    .split('/')
    .filter((segment) => segment.length > 0)
    .slice(-1)[0];
  return last || pathLike.trim();
}

function extractHttpStatus(err: unknown): number | null {
  const text = err instanceof Error ? err.message : String(err);
  const match = /\((\d{3})\)/.exec(text) ?? /\bstatus(?:=|:)\s*(\d{3})\b/i.exec(text);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isOwnerRepo(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.trim() !== value) return false;
  return /^[^/]+\/[^/]+$/.test(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
