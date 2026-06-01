/**
 * Tool context handle interfaces. Orchestrators populate `ctx.handles[*]`
 * with implementations of these contracts; the tool implementations type-cast
 * out of `ctx.handles` using these names.
 */

import type { DossierStore } from '../analyst/dossier';
import type { SemanticSuspectSeed } from '../analyst/semantic-search';
import type { InvestigationNotesStore } from '../fix-loop/investigation-notes';
import type { HypothesisTracker } from '../fix-loop/hypotheses';

export interface WorkspaceReader {
  /** Read a repo file at the agent's working ref. Returns null if not found. */
  readFile(path: string): Promise<string | null>;
  /** List directory entries (non-recursive). */
  listDir(path: string): Promise<{ name: string; isDir: boolean }[]>;
  /** Run a literal-or-regex search. Returns file:line:text matches. */
  grep(pattern: string, paths: string[] | undefined, flags: { caseInsensitive?: boolean }): Promise<GrepMatch[]>;
  /** Read the current git diff (HEAD vs base). */
  readDiff(): Promise<string>;
  /** Git log for a path (latest N entries). */
  gitLog(path: string | undefined, n: number): Promise<GitLogEntry[]>;
  /** Git blame for a path range. */
  gitBlame(path: string, lineStart?: number, lineEnd?: number): Promise<GitBlameLine[]>;
  /** List changed files in current working set vs base. */
  changedFiles(): Promise<string[]>;
}

export interface GrepMatch {
  path: string;
  line: number;
  text: string;
}
export interface GitLogEntry {
  sha: string;
  author: string;
  date: string;
  message: string;
  files: string[];
}
export interface GitBlameLine {
  sha: string;
  author: string;
  date: string;
  line: number;
  text: string;
}

export interface WorkspaceWriter {
  /** Write a test file (caller path-scoped). */
  writeTest(path: string, content: string): Promise<void>;
  /** Apply a structured search/replace patch. */
  applyPatch(patch: { path: string; oldText: string; newText: string }): Promise<{ patchId: string }>;
  /** Revert a single file to its baseline state. */
  revertFile(path: string): Promise<void>;
  /** Roots considered "tests" for the path-scope guard. */
  testRoots(): string[];
  /** affectedModule used as the diff scope. */
  affectedModule(): string;
  /** The path of the canonical repro test (for scope). */
  reproTestPath(): string | undefined;
}

export interface SandboxHandle {
  /** Set the canonical repro test path AFTER it has been chosen (repro-loop). */
  setReproTestPath(p: string): void;
  /** Run the recorded repro test. Returns full result. */
  runRepro(): Promise<SandboxRun>;
  /** Run the broader test command. */
  runTests(scopePath?: string): Promise<SandboxRun>;
  /** Run a bounded python snippet (no shell). */
  runPython(snippet: string, env?: Record<string, string>): Promise<SandboxRun>;
  /** Install a pip package by name+version (or requirement string). */
  pipInstall(spec: string): Promise<SandboxRun>;
  /** Check whether a python module is importable. */
  pythonModuleCheck(name: string): Promise<{
    importable: boolean;
    module?: string;
    version?: string;
    error?: string;
    tried?: string[];
  }>;
  /** List currently installed packages. */
  listPackages(): Promise<{ name: string; version: string }[]>;
}

export interface SandboxRun {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface IssueHandle {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
}

export interface RepoHandle {
  fullName: string;
  forkFullName: string;
  branch: string;
  baselineSha: string;
  affectedModule: string;
  language: 'python' | 'javascript' | 'typescript' | 'go' | 'other';
}

export interface PlanState {
  /** Returns the current plan body if commit_plan has been called. */
  getPlan(): Plan | null;
  /** Commit a new plan (called by Fix Planner). */
  commitPlan(p: Plan): void;
}

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export interface PlanStep {
  stepId: string;
  goal: string;
  hypothesisSummary: string;
  successCheck: string;
  files: string[];
  risk: 'low' | 'medium' | 'high';
}

export interface ToolHandles {
  workspace: WorkspaceReader & WorkspaceWriter;
  sandbox: SandboxHandle;
  issue: IssueHandle;
  repo: RepoHandle;
  dossier?: DossierStore;       // Analyst writes; everyone else reads
  semanticSuspectSeed?: SemanticSuspectSeed | null;
  notes?: InvestigationNotesStore; // Fix Investigator writes; downstream reads
  hypotheses?: HypothesisTracker;
  plan?: PlanState;
}

/** Helper for tool execute() bodies. */
export function asHandles(raw: Record<string, unknown>): ToolHandles {
  return raw as unknown as ToolHandles;
}
