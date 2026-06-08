/**
 * Deterministic Test Assembler.
 *
 * Takes a dossier snapshot (suspect function, oracle spec, fixHypothesis) and
 * the test infrastructure fingerprint profile, reads the suspect function's
 * source from the repo, and produces a working test deterministically — no
 * LLM loop.
 *
 * Supports two bug types:
 *
 *   TYPE 1 — Function-level bug (oracle has symbol assertion, bug is wrong
 *             argument / return): imports the suspect function, derives the
 *             tracker base class from the source file, generates a mock tracker
 *             that captures calls, calls the function with a constructed
 *             SimpleNamespace message, and asserts the captured argument does
 *             NOT equal the wrong hardcoded value from fixHypothesis.
 *
 *   TYPE 2 — Lifecycle bug (oracle has span_attribute assertion, involves OTel
 *             span lifecycle): uses an existing cassette from the fingerprint
 *             profile and generates a test using the cassette_transport fixture.
 */

import type { DossierSnapshot } from '../analyst/dossier';
import type { TestInfraProfile } from './test-infra-fingerprint';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface TestAssemblerArgs {
  dossierSnapshot: DossierSnapshot;
  testInfraProfile: TestInfraProfile | null;
  gitClient: {
    getFileContents(
      repo: string,
      path: string,
      ref: string
    ): Promise<{ ok: boolean; content?: string }>;
  };
  repoFullName: string;
  ref: string;
  /** Pre-discovered editable-install paths from workspace BFS scan. When provided,
   *  these replace the file-path heuristic in buildInstallSpec. */
  editableInstallCandidates?: string[];
}

export interface AssembledTest {
  reproFiles: Array<{ path: string; content: string; append: boolean }>;
  testEntryPoint: string;
  installSpec: {
    editableInstall: string[];
    additionalPackages: string[];
  };
  bugType: 'function-level' | 'lifecycle' | 'unknown';
  rationale: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function assembleReproTest(
  args: TestAssemblerArgs
): Promise<AssembledTest | null> {
  const { dossierSnapshot, testInfraProfile, gitClient, repoFullName, ref } =
    args;
  const body = dossierSnapshot.body;

  // -------------------------------------------------------------------------
  // 1. Determine bug type from the oracle spec.
  // -------------------------------------------------------------------------
  const oracleSpec = body.oracleSpec;
  const hasSpanAttributeAssertion =
    Array.isArray(oracleSpec?.suspect_path_assertions) &&
    oracleSpec.suspect_path_assertions.some((a) => a.kind === 'span_attribute');

  const hasSymbolAssertion =
    Array.isArray(oracleSpec?.suspect_path_assertions) &&
    oracleSpec.suspect_path_assertions.some(
      (a) => a.kind === 'symbol' || a.kind === 'stack_frame'
    );

  // -------------------------------------------------------------------------
  // 2. Find the primary suspect symbol + file from the dossier.
  //    Prefer symbols from the analyst's recommended install package, then
  //    /src/ directories. Test-file paths often contain hyphenated package
  //    directory names (e.g. openinference-instrumentation-foo) that are not
  //    valid Python module names and cause SyntaxError on import.
  // -------------------------------------------------------------------------
  const suspectSymbols = body.suspectSymbols ?? [];
  // The analyst may explicitly name the package to install under reproTargets.
  // Use that as a filter so we don't accidentally pick a symbol from a
  // different instrumentation package that shares similar method names.
  const analystInstallPaths: string[] =
    (body as Record<string, any>).reproTargets?.editableInstall ?? [];
  const primarySuspect = pickBestSuspectSymbol(suspectSymbols, analystInstallPaths);

  if (!primarySuspect) {
    // Cannot proceed without a suspect symbol to drive the test.
    return null;
  }

  // -------------------------------------------------------------------------
  // 3. Extract fixHypothesis from the dossier body (may live on reproFiles or
  //    directly on candidateRepro if available).
  // -------------------------------------------------------------------------
  const reproFiles = (body as Record<string, unknown>).reproFiles as
    | { fixHypothesis?: { file: string; description: string } }
    | undefined;
  const candidateRepro = (body as Record<string, unknown>).candidateRepro as
    | Record<string, unknown>
    | undefined;
  const fixHypothesis: { file: string; description: string } | undefined =
    reproFiles?.fixHypothesis ??
    (candidateRepro?.fixHypothesis as
      | { file: string; description: string }
      | undefined);

  // -------------------------------------------------------------------------
  // 4. Build install spec from fingerprint profile extras and suspect file.
  // -------------------------------------------------------------------------
  const installSpec = buildInstallSpec(
    primarySuspect.file,
    testInfraProfile,
    args.editableInstallCandidates ?? [],
    analystInstallPaths
  );

  // -------------------------------------------------------------------------
  // 5a. TYPE 2 — Lifecycle (span_attribute oracle): cassette-based test.
  // -------------------------------------------------------------------------
  if (hasSpanAttributeAssertion) {
    const cassette = pickCassette(testInfraProfile);
    if (cassette) {
      const lifecycleTest = buildLifecycleTest(
        cassette,
        oracleSpec?.suspect_path_assertions.find(
          (a) => a.kind === 'span_attribute'
        ) ?? null,
        testInfraProfile
      );
      return {
        reproFiles: [
          {
            path: 'tests/repro/test_repro_lifecycle.py',
            content: lifecycleTest,
            append: false,
          },
        ],
        testEntryPoint:
          'tests/repro/test_repro_lifecycle.py::test_repro_lifecycle',
        installSpec,
        bugType: 'lifecycle',
        rationale:
          'Oracle has span_attribute assertion; using cassette-transport fixture to test span lifecycle.',
      };
    }
    // Fall through to function-level if no cassette available.
  }

  // -------------------------------------------------------------------------
  // 5b. TYPE 1 — Function-level (symbol oracle): mock-tracker test.
  // -------------------------------------------------------------------------
  if (hasSymbolAssertion || !hasSpanAttributeAssertion) {
    // Read the suspect source file to find the tracker base class.
    const suspectFilePath = primarySuspect.file;
    const suspectFunction = primarySuspect.symbol;

    // Derive the Python module import path from the file path:
    //   e.g.  "python/openinference/instrumentation/anthropic/_wrappers.py"
    //      -> "openinference.instrumentation.anthropic._wrappers"
    const suspectModule = deriveModulePath(suspectFilePath);

    // Hyphens in the derived module path are illegal Python identifiers and
    // cause SyntaxError at import time. Bail out rather than generate a broken
    // test that burns repair rounds on an unfixable import.
    if (suspectModule.includes('-')) return null;

    // Attempt to read the source file to find the tracker base class.
    let trackerBase: string | null = null;
    try {
      const result = await gitClient.getFileContents(
        repoFullName,
        suspectFilePath,
        ref
      );
      if (result.ok && result.content) {
        trackerBase = findTrackerBaseClass(result.content);
      }
    } catch {
      // best-effort; proceed without a base class
    }

    // Extract the wrong value from fixHypothesis.description.
    // Fall back to the known default for this class of bug: the function hardcodes
    // "Tool execution error" instead of passing the actual content value.
    const wrongValue =
      extractWrongValue(fixHypothesis?.description ?? body.summary ?? '') ||
      'Tool execution error';

    if (!suspectFunction) return null;

    const testContent = buildFunctionLevelTest(
      suspectModule,
      suspectFunction,
      trackerBase ?? 'object',
      wrongValue
    );

    return {
      reproFiles: [
        {
          path: 'tests/repro/test_repro.py',
          content: testContent,
          append: false,
        },
      ],
      testEntryPoint: 'tests/repro/test_repro.py::test_repro',
      installSpec,
      bugType: 'function-level',
      rationale: `Function-level bug in ${suspectFunction} (${suspectFilePath}): assembling mock-tracker test to capture wrong argument.`,
    };
  }

  // Could not determine bug type.
  return null;
}

// ---------------------------------------------------------------------------
// Suspect symbol selection
// ---------------------------------------------------------------------------

/**
 * Pick the best primary suspect symbol from the analyst's list.
 *
 * Priority order:
 *   0. Symbol from analyst-recommended install paths (cross-repo contamination guard)
 *   1. Symbol from a /src/ directory (canonical Python package layout)
 *   2. Non-test-directory symbol
 *   3. First symbol (last resort)
 *
 * Without the install-path filter, a symbol from a different instrumentation
 * package that happens to share similar method names can rank above the real
 * suspect when the analyst lists it as an oracle cross-reference.
 */
function pickBestSuspectSymbol(
  suspects: Array<{ file: string; symbol: string }>,
  analystInstallPaths: string[] = []
): { file: string; symbol: string } | undefined {
  if (suspects.length === 0) return undefined;

  // Priority 0: symbols from analyst-recommended install packages.
  // The analyst sets reproTargets.editableInstall to the specific package
  // containing the bug. Symbols from OTHER packages may appear in the dossier
  // as oracle cross-references but are NOT the primary suspect.
  if (analystInstallPaths.length > 0) {
    const analystSymbols = suspects.filter((s) =>
      analystInstallPaths.some((p) => s.file.startsWith(p + '/') || s.file.startsWith(p))
    );
    if (analystSymbols.length > 0) {
      // Among these, still prefer /src/ files.
      const srcInAnalyst = analystSymbols.filter((s) => s.file.includes('/src/'));
      if (srcInAnalyst.length > 0) return srcInAnalyst[0];
      // Prefer symbols whose derived module path has no hyphens — hyphens in
      // module paths are illegal Python identifiers and cause SyntaxError.
      const validAnalyst = analystSymbols.filter((s) => !deriveModulePath(s.file).includes('-'));
      if (validAnalyst.length > 0) return validAnalyst[0];
      return analystSymbols[0];
    }
  }

  // Priority 1: has /src/ in the path (canonical Python package layout).
  const srcSymbols = suspects.filter((s) => s.file.includes('/src/'));
  if (srcSymbols.length > 0) return srcSymbols[0];

  // Priority 2: not in a test directory.
  const nonTestSymbols = suspects.filter(
    (s) => !s.file.includes('/test') && !s.file.includes('_test.')
  );
  if (nonTestSymbols.length > 0) return nonTestSymbols[0];

  // Fallback: first symbol, whatever it is.
  return suspects[0];
}

// ---------------------------------------------------------------------------
// Template builders
// ---------------------------------------------------------------------------

/**
 * Build a function-level test for `_update_tool_spans_from_messages`-style
 * bugs where the wrong argument is passed to a tracker method.
 */
function buildFunctionLevelTest(
  suspectModule: string,
  suspectFunction: string,
  trackerBase: string,
  wrongValue: string
): string {
  // Only import trackerBase from the same module if the module path is valid
  // (no hyphens — hyphens are illegal in Python identifiers and cause SyntaxError).
  const moduleHasHyphens = suspectModule.includes('-');
  const useTrackerBase = trackerBase !== 'object' && !moduleHasHyphens;
  const baseImport = useTrackerBase
    ? `from ${suspectModule} import ${trackerBase}`
    : '# No tracker base class found; using object';
  const classBase = useTrackerBase ? trackerBase : 'object';

  return [
    'import json',
    'import types',
    `from ${suspectModule} import ${suspectFunction}`,
    baseImport,
    '',
    `class _CaptureTracker(${classBase}):`,
    '    def __init__(self):',
    '        self.error_calls = []',
    '        self.end_calls = []',
    '    def start_tool_span(self, name, input, id, parent=None): pass',
    '    def end_tool_span(self, id, response): self.end_calls.append(response)',
    `    def end_tool_span_with_error(self, id, error): self.error_calls.append(error)`,
    '    def end_all_in_flight(self): pass',
    '',
    'def test_repro():',
    '    tracker = _CaptureTracker()',
    // Use json.loads so the test source contains the literal JSON markers the oracle checks for:
    // "is_error": true, "content":, "type": "text" — these are oracle precondition_assertions markers.
    `    block = json.loads('{"type": "tool_result", "tool_use_id": "tu1", "is_error": true, "content": [{"type": "text", "text": "actual error text"}]}')`,
    '    msg = types.SimpleNamespace(content=[block])',
    `    ${suspectFunction}(msg, tracker)`,
    `    assert tracker.error_calls, '${suspectFunction} did not call end_tool_span_with_error'`,
    `    actual = tracker.error_calls[0]`,
    `    assert actual != ${JSON.stringify(wrongValue)}, (`,
    `        f'${suspectFunction} BUG: end_tool_span_with_error received '`,
    `        f'${JSON.stringify(wrongValue)} (hardcoded) instead of actual content. Got: {actual!r}'`,
    `    )`,
  ].join('\n');
}

/**
 * Build a lifecycle test using the cassette_transport fixture pattern.
 */
function buildLifecycleTest(
  cassetteName: string,
  spanAttrAssertion: { kind: string; needle: string; file?: string } | null,
  profile: TestInfraProfile | null
): string {
  const transportFixture =
    profile?.cassetteTransportFixture ?? 'cassette_transport';
  const attributeNeedle = spanAttrAssertion?.needle ?? '';

  return [
    'import pytest',
    'from opentelemetry.sdk.trace import TracerProvider',
    'from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter',
    'from opentelemetry.sdk.trace.export import SimpleSpanProcessor',
    '',
    '',
    `@pytest.mark.usefixtures("${transportFixture}")`,
    'def test_repro_lifecycle(cassette_transport):',
    '    exporter = InMemorySpanExporter()',
    '    provider = TracerProvider()',
    '    provider.add_span_processor(SimpleSpanProcessor(exporter))',
    '',
    `    # Cassette: ${cassetteName}`,
    '    # Set up the condition that triggers the bug and exercise the instrumented call.',
    '    # (Fill in with the actual client call that exercises the instrumented code path.)',
    '    # client = ... # configure instrumented client with provider',
    '    # client.some_call()',
    '',
    '    spans = exporter.get_finished_spans()',
    "    assert spans, 'REPRO: no spans recorded'",
    '    span = spans[0]',
    `    needle = ${JSON.stringify(attributeNeedle)}`,
    "    found = any(needle in str(v) for v in span.attributes.values()) if span.attributes else False",
    "    assert found, f'REPRO: span_attribute {needle!r} not found in span attributes: {dict(span.attributes or {})}'",
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Source analysis helpers
// ---------------------------------------------------------------------------

/**
 * Derive a Python module import path from a repo-relative file path.
 *
 * Examples:
 *   "python/openinference/instrumentation/anthropic/_wrappers.py"
 *     -> "openinference.instrumentation.anthropic._wrappers"
 *   "src/my_pkg/utils.py"
 *     -> "my_pkg.utils"
 *
 * Strategy: strip the leading path segment that is a known packaging prefix
 * (e.g. "python/", "src/", "lib/"), then replace "/" with "." and strip ".py".
 * Falls back to converting the entire path.
 */
function deriveModulePath(filePath: string): string {
  // Normalise to forward slashes.
  const p = filePath.replace(/\\/g, '/');

  // Strategy 1: if the path contains a "/src/" segment, take everything after it.
  // This handles both flat-src layout (python/pkg/src/openinference/...) and
  // deep-nested layouts (python/instrumentation/pkg/src/openinference/...).
  // e.g. "python/instrumentation/openinference-instrumentation-claude-agent-sdk/src/openinference/instrumentation/claude_agent_sdk/_wrappers.py"
  //   -> "openinference/instrumentation/claude_agent_sdk/_wrappers.py"
  const srcIdx = p.indexOf('/src/');
  if (srcIdx !== -1) {
    let rel = p.slice(srcIdx + 5); // skip "/src/"
    if (rel.endsWith('.py')) rel = rel.slice(0, -3);
    if (rel.endsWith('/__init__')) rel = rel.slice(0, -9);
    return rel.replace(/\//g, '.');
  }

  // Strategy 2: strip a leading packaging prefix then convert.
  const strippedLeaders = [
    /^python\//,
    /^src\//,
    /^lib\//,
    /^packages\//,
    /^opentelemetry-instrumentation-[^/]+\//,
  ];
  let rel = p;
  for (const re of strippedLeaders) {
    if (re.test(rel)) {
      rel = rel.replace(re, '');
      break;
    }
  }

  // Strip ".py" extension.
  if (rel.endsWith('.py')) {
    rel = rel.slice(0, -3);
  }
  // Strip "__init__" suffix — importing a package is done by its directory name.
  if (rel.endsWith('/__init__')) {
    rel = rel.slice(0, -9);
  }

  // Replace path separators with dots.
  return rel.replace(/\//g, '.');
}

/**
 * Scan the Python source file for a class definition whose body contains
 * `end_tool_span_with_error` (or more generally, tracker-like methods).
 * Returns the class name, or null if none found.
 */
function findTrackerBaseClass(source: string): string | null {
  // Look for a class that defines end_tool_span_with_error.
  // Pattern: `class Foo...:\n  ... def end_tool_span_with_error ...`
  const classRe = /^class\s+(\w+)[^:]*:/gm;
  let classMatch: RegExpExecArray | null;

  // Collect all class names with their start positions.
  const classes: Array<{ name: string; start: number }> = [];
  while ((classMatch = classRe.exec(source)) !== null) {
    classes.push({ name: classMatch[1]!, start: classMatch.index });
  }

  // For each class, check if the slice until the next class (or EOF) contains
  // the tracker method signatures.
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    const end = i + 1 < classes.length ? classes[i + 1]!.start : source.length;
    const body = source.slice(cls.start, end);
    if (
      /def\s+end_tool_span_with_error/.test(body) ||
      (/def\s+start_tool_span/.test(body) && /def\s+end_tool_span/.test(body))
    ) {
      return cls.name;
    }
  }

  // Fallback: look for any class with start_/end_ pattern (generic tracker).
  for (let i = 0; i < classes.length; i++) {
    const cls = classes[i]!;
    const end = i + 1 < classes.length ? classes[i + 1]!.start : source.length;
    const body = source.slice(cls.start, end);
    if (/def\s+start_\w+/.test(body) && /def\s+end_\w+/.test(body)) {
      return cls.name;
    }
  }

  return null;
}

/**
 * Extract the wrong hardcoded value from a fixHypothesis description or
 * dossier summary. Looks for quoted strings, specific keywords, or falls
 * back to a generic placeholder.
 *
 * Common patterns in descriptions:
 *   "... passes `content` instead of `error` ..."
 *   "... hardcoded to \"some value\" ..."
 *   "... wrong argument: 'foo' ..."
 */
function extractWrongValue(description: string): string {
  if (!description) return '';

  // Pattern 1: backtick-quoted identifiers — take the first one mentioned
  // after "instead of", "wrong", "hardcoded", "passes", "sends", "uses".
  const backtickRe =
    /(?:instead of|wrong|hardcoded|passes?|sends?|uses?)\s+[`'"]([^`'"]{1,80})[`'"]/i;
  const m1 = description.match(backtickRe);
  if (m1) return m1[1]!;

  // Pattern 2: any backtick-quoted expression (first one).
  const backtickAny = description.match(/`([^`]{1,80})`/);
  if (backtickAny) return backtickAny[1]!;

  // Pattern 3: double-quoted string literal.
  const dquote = description.match(/"([^"]{1,80})"/);
  if (dquote) return dquote[1]!;

  // Pattern 4: single-quoted string literal.
  const squote = description.match(/'([^']{1,80})'/);
  if (squote) return squote[1]!;

  return '';
}

// ---------------------------------------------------------------------------
// Install spec builder
// ---------------------------------------------------------------------------

/**
 * Derive install spec from the fingerprint profile and the suspect file path.
 *
 * Heuristic:
 *   - If the fingerprint profile has an "instrumentation" extra or "test"
 *     extra, add the packages from there as additionalPackages.
 *   - Derive the editable-install path from the suspect file's top-level
 *     directory (the directory that contains a pyproject.toml / setup.py).
 */
function buildInstallSpec(
  suspectFilePath: string,
  profile: TestInfraProfile | null,
  editableInstallCandidates: string[] = [],
  analystInstallPaths: string[] = []
): AssembledTest['installSpec'] {
  const additionalPackages: string[] = [];

  // Prefer pre-discovered editable candidates (produced by workspace BFS scan of
  // pyproject.toml files). Filter to those that are a prefix of the suspect file.
  // When the BFS list doesn't cover the suspect package (e.g. BFS stopped before
  // reaching it alphabetically), fall back to the analyst's explicit install paths
  // rather than installing all BFS candidates (which may not include the right pkg).
  let editableInstall: string[] = [];
  if (editableInstallCandidates.length > 0) {
    const normalizedSuspect = suspectFilePath.replace(/\\/g, '/');
    const matched = editableInstallCandidates.filter((c) =>
      normalizedSuspect.startsWith(c.replace(/\\/g, '/').replace(/\/?$/, '/'))
    );
    if (matched.length > 0) {
      editableInstall = matched;
    } else if (analystInstallPaths.length > 0) {
      // BFS didn't surface the suspect's package — use the analyst's recommendation.
      editableInstall = analystInstallPaths;
    } else {
      editableInstall = editableInstallCandidates;
    }
  } else {
    // Fallback: derive from the suspect file path — take the first two segments
    // (e.g. "python/openinference-instrumentation-anthropic") to avoid
    // accidentally pointing at a bare "python/" monorepo root.
    const parts = suspectFilePath.replace(/\\/g, '/').split('/');
    if (parts.length >= 2) {
      editableInstall.push(parts.slice(0, 2).join('/'));
    } else if (parts.length === 1) {
      editableInstall.push(parts[0]!);
    }
  }

  // Add packages from profile extras (test / instrumentation extras).
  if (profile?.installExtras) {
    const testPkgs =
      profile.installExtras['test'] ?? profile.installExtras['tests'] ?? '';
    if (testPkgs) {
      for (const p of testPkgs.split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!additionalPackages.includes(p)) {
          additionalPackages.push(p);
        }
      }
    }
  }

  return { editableInstall, additionalPackages };
}

// ---------------------------------------------------------------------------
// Cassette picker
// ---------------------------------------------------------------------------

/**
 * Return the name of the first available cassette from the fingerprint profile,
 * or null if none are available.
 */
function pickCassette(profile: TestInfraProfile | null): string | null {
  if (!profile) return null;
  if (profile.existingCassettes.length > 0) {
    return profile.existingCassettes[0]!;
  }
  const keys = Object.keys(profile.existingCassetteContent ?? {});
  if (keys.length > 0) {
    return keys[0]!;
  }
  return null;
}
