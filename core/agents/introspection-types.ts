/**
 * Introspection agent types (US-104).
 */

export type LanguageStack =
  | 'node'
  | 'python'
  | 'rust'
  | 'go'
  | 'java-maven'
  | 'java-gradle'
  | 'unknown';

export type PackageManifestKind =
  | 'package.json'
  | 'pyproject.toml'
  | 'setup.py'
  | 'Cargo.toml'
  | 'go.mod'
  | 'pom.xml'
  | 'build.gradle'
  | 'build.gradle.kts';

export interface CiWorkflowSignal {
  /** Path to the workflow file relative to the repo root. */
  path: string;
  /** Extracted step `run:` blocks (verbatim-ish). */
  commands: string[];
}

export interface PackageManifestSignal {
  /** Path to the manifest file relative to the repo root. */
  path: string;
  kind: PackageManifestKind;
  stack: LanguageStack;
  /** Best-effort hint about how tests are typically run for this stack. */
  testHint: string;
}

export interface MakefileTargetSignal {
  path: string;
  target: string;
}

export interface ContributingDocSignal {
  path: string;
  /** Markdown fenced code blocks extracted from the doc. */
  codeBlocks: string[];
}

export interface ComposeServicesSignal {
  path: string;
  /** Service names under the `services:` key (best-effort YAML extraction). */
  services: string[];
}

export interface RepoSignals {
  repoFullName: string;
  ciWorkflows: CiWorkflowSignal[];
  packageManifests: PackageManifestSignal[];
  makefileTargets: MakefileTargetSignal[];
  contributingDocs: ContributingDocSignal[];
  composeServices: ComposeServicesSignal[];
  /** README content used only as a fallback when no other test signals were found. */
  readme: string;
  /** When a monorepo is detected, maps subdirectory -> stack(s). */
  monorepoLayout: Record<string, LanguageStack[]>;
}

export interface RepoCloner {
  /**
   * Clone a repo into destDir.
   *
   * Production implementation uses a shallow git clone; tests can provide a fixture copier.
   */
  clone(repoFullName: string, destDir: string): Promise<void>;
}

/** Draft output produced by generateDraftAdapter() (US-105). */
export interface DraftAdapter {
  adapterTs: string;
  manifestYaml: string;
  rationale: Record<string, string>;
  openItems: string[];
}
