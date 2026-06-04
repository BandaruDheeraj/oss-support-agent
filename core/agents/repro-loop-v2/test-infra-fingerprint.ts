/**
 * Test infrastructure fingerprinter.
 *
 * Reads a target repo's test setup before the analyst runs so the analyst can
 * produce conformant tests on the first try. All reads are best-effort: any
 * individual file failure is swallowed and the profile is returned with
 * partial data.
 *
 * Covers:
 *   - Cassette/recording conventions from conftest.py
 *   - Test fixture names from conftest.py (@pytest.fixture)
 *   - pip extras from pyproject.toml [project.optional-dependencies]
 *   - Existing cassette names from the cassettes directory tree
 *   - Module-level imports from one existing integration test file
 *   - SDK base classes from conftest and test imports
 *   - Async test markers
 *   - Lint tool versions from tox.ini or pyproject.toml
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TestInfraProfile {
  /** Human description of the naming rule inferred from conftest.py */
  cassetteNamingConvention: string | null;
  /** e.g. "cassette_transport" – the fixture name that injects the transport */
  cassetteTransportFixture: string | null;
  /** All @pytest.fixture names found in conftest.py */
  availableFixtures: string[];
  /** Top-level import lines from one existing test file */
  existingTestImports: string[];
  /**
   * Map of class-name → import-path for SDK base classes seen in conftest or
   * test imports, e.g. { SpanProcessor: "opentelemetry.sdk.trace.SpanProcessor" }
   */
  sdkBaseClasses: Record<string, string>;
  /**
   * Map of extra-name → package list for optional-dependency extras from
   * pyproject.toml, e.g. { test: ["pytest", "pytest-asyncio"] }
   */
  installExtras: Record<string, string>;
  /** Packages inferred from conftest.py and test top-level imports */
  additionalPackages: string[];
  /** Existing cassette names without extension, e.g. ["test_chat", "test_stream"] */
  existingCassettes: string[];
  /** e.g. "@pytest.mark.asyncio" */
  asyncTestMarker: string | null;
  /** e.g. { ruff: "0.9.2" } from tox.ini or pyproject.toml */
  pinnedToolVersions: Record<string, string>;
  /** Path to the closest existing test file (first one that was successfully read) */
  closestExistingTest: string | null;
  /** Content of up to 3 existing cassettes (name → raw YAML, capped at 8KB each) */
  existingCassetteContent: Record<string, string>;
}

// ---------------------------------------------------------------------------
// GitClient interface (inline, matches core/sandbox-session.ts GitClient shape)
// ---------------------------------------------------------------------------

interface GitClientLike {
  getFileContents(
    repo: string,
    path: string,
    ref: string
  ): Promise<{ ok: boolean; content?: string }>;
  getDefaultBranch(repo: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fingerprintTestInfra(args: {
  repoFullName: string;
  affectedPackagePath: string;
  gitClient: GitClientLike;
}): Promise<TestInfraProfile> {
  const { gitClient, repoFullName, affectedPackagePath } = args;
  const pkg = affectedPackagePath.replace(/\/$/, '');

  // Resolve the default branch to use as ref
  let ref: string;
  try {
    ref = await gitClient.getDefaultBranch(repoFullName);
  } catch {
    ref = 'main';
  }

  const profile: TestInfraProfile = {
    cassetteNamingConvention: null,
    cassetteTransportFixture: null,
    availableFixtures: [],
    existingTestImports: [],
    sdkBaseClasses: {},
    installExtras: {},
    additionalPackages: [],
    existingCassettes: [],
    asyncTestMarker: null,
    pinnedToolVersions: {},
    closestExistingTest: null,
    existingCassetteContent: {},
  };

  // Run all reads concurrently; each is independently try/caught.
  await Promise.all([
    parseConftest(gitClient, repoFullName, ref, pkg, profile),
    parsePyproject(gitClient, repoFullName, ref, pkg, profile),
    parseToxIni(gitClient, repoFullName, ref, pkg, profile),
    readOneTestFile(gitClient, repoFullName, ref, pkg, profile),
  ]);

  // Fetch content of up to 3 existing cassettes (8KB cap each) so the analyst
  // can copy a real cassette structure when writing integration repro tests.
  profile.existingCassetteContent = {};
  const cassetteDir = affectedPackagePath + '/tests/cassettes/test_instrumentor';
  for (const name of profile.existingCassettes.slice(0, 3)) {
    const cassettePath = cassetteDir + '/' + name + '.yaml';
    const content = await gitClient.getFileContents(repoFullName, cassettePath, ref);
    if (content.ok && content.content) {
      profile.existingCassetteContent[name] = content.content.slice(0, 8000);
    }
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Step 1: Parse conftest.py
// ---------------------------------------------------------------------------

async function parseConftest(
  gitClient: GitClientLike,
  repoFullName: string,
  ref: string,
  pkg: string,
  profile: TestInfraProfile
): Promise<void> {
  try {
    const result = await gitClient.getFileContents(
      repoFullName,
      `${pkg}/tests/conftest.py`,
      ref
    );
    if (!result.ok || !result.content) return;
    const src = result.content;

    // --- Fixture names -------------------------------------------------------
    // Match both @pytest.fixture and @pytest.fixture(...)
    const fixtureRe = /^@pytest\.fixture(?:\([^)]*\))?\s*\ndef\s+(\w+)/gm;
    let m: RegExpExecArray | null;
    while ((m = fixtureRe.exec(src)) !== null) {
      const name = m[1];
      if (!profile.availableFixtures.includes(name)) {
        profile.availableFixtures.push(name);
      }
    }

    // --- Cassette transport fixture ------------------------------------------
    // Look for a fixture that yields or returns a ReplayTransport / transport
    // object. Heuristic: fixture whose name contains "transport", "cassette",
    // "vcr", or "replay".
    const cassetteFxRe =
      /^@pytest\.fixture(?:\([^)]*\))?\s*\ndef\s+(\w*(?:transport|cassette|vcr|replay)\w*)\b/gim;
    while ((m = cassetteFxRe.exec(src)) !== null) {
      if (!profile.cassetteTransportFixture) {
        profile.cassetteTransportFixture = m[1];
      }
    }

    // If no name-based match, look for a fixture whose body contains
    // ReplayTransport, httpretty, responses, respx, or VCR.
    if (!profile.cassetteTransportFixture) {
      const allFxBlocks = extractFixtureBlocks(src);
      for (const [name, body] of allFxBlocks) {
        if (/ReplayTransport|VCR|httpretty|responses\.activate|respx/i.test(body)) {
          profile.cassetteTransportFixture = name;
          break;
        }
      }
    }

    // --- Cassette naming convention ------------------------------------------
    // Look for a function like `_cassette_path`, `cassette_path`, etc.
    const cassettePathFnRe =
      /def\s+(\w*cassette_path\w*|get_cassette_path|cassette_name|_cassette_name)\s*\([^)]*\)/gi;

    m = cassettePathFnRe.exec(src);
    if (m) {
      const startIdx = m.index;
      const snippet = src.slice(startIdx, startIdx + 1200);
      const convention = inferNamingConvention(snippet);
      if (convention) {
        profile.cassetteNamingConvention = convention;
      }
    }

    // Fallback: scan for f-strings or path patterns containing "cassette".
    if (!profile.cassetteNamingConvention) {
      const fstringRe = /f["']([^"']*cassette[^'"]*)['"]/i;
      const fm = src.match(fstringRe);
      if (fm) {
        profile.cassetteNamingConvention = inferNamingConvention(fm[0]) ?? `Path template: ${fm[1]}`;
      }
    }

    // --- Async test marker ---------------------------------------------------
    if (/pytest\.mark\.asyncio/i.test(src)) {
      profile.asyncTestMarker = '@pytest.mark.asyncio';
    } else if (/pytest\.mark\.anyio/i.test(src)) {
      profile.asyncTestMarker = '@pytest.mark.anyio';
    }

    // --- SDK base classes from imports ---------------------------------------
    mergeBaseClasses(src, profile.sdkBaseClasses);

    // --- Additional test packages from imports -------------------------------
    const importedPackages = extractTopLevelPackages(src);
    for (const p of importedPackages) {
      if (!profile.additionalPackages.includes(p)) {
        profile.additionalPackages.push(p);
      }
    }
  } catch {
    // best effort — ignore any error
  }
}

// ---------------------------------------------------------------------------
// Step 2: Parse pyproject.toml
// ---------------------------------------------------------------------------

async function parsePyproject(
  gitClient: GitClientLike,
  repoFullName: string,
  ref: string,
  pkg: string,
  profile: TestInfraProfile
): Promise<void> {
  try {
    const result = await gitClient.getFileContents(
      repoFullName,
      `${pkg}/pyproject.toml`,
      ref
    );
    if (!result.ok || !result.content) return;
    const src = result.content;

    // --- [project.optional-dependencies] -------------------------------------
    // Match the section header and collect the extras with their package lists.
    const optDepsSectionRe = /\[project\.optional-dependencies\]([\s\S]*?)(?=^\[|\z)/m;
    const sectionMatch = src.match(optDepsSectionRe);
    if (sectionMatch) {
      const sectionBody = sectionMatch[1];
      // Each extra: key = [\n  "pkg1",\n  "pkg2",\n]
      const extraBlockRe = /^([\w][\w-]*)\s*=\s*\[([\s\S]*?)\]/gm;
      let m: RegExpExecArray | null;
      while ((m = extraBlockRe.exec(sectionBody)) !== null) {
        const extraName = m[1];
        // Extract individual package specs from the bracket content
        const pkgList = m[2]
          .split(/[\n,]/)
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter((s) => s.length > 0);
        profile.installExtras[extraName] = pkgList.join(', ');
      }
    }

    // --- Pinned tool versions from dev/lint dependency entries ---------------
    mergePinnedVersionsFromPyproject(src, profile.pinnedToolVersions);

    // --- Async marker from tool.pytest.ini_options --------------------------
    if (!profile.asyncTestMarker) {
      if (/asyncio_mode\s*=\s*["']?auto/i.test(src)) {
        profile.asyncTestMarker = '@pytest.mark.asyncio';
      }
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Step 3: Parse tox.ini for pinned tool versions
// ---------------------------------------------------------------------------

async function parseToxIni(
  gitClient: GitClientLike,
  repoFullName: string,
  ref: string,
  pkg: string,
  profile: TestInfraProfile
): Promise<void> {
  try {
    const result = await gitClient.getFileContents(
      repoFullName,
      `${pkg}/tox.ini`,
      ref
    );
    if (!result.ok || !result.content) return;
    const src = result.content;
    mergePinnedVersionsFromToxIni(src, profile.pinnedToolVersions);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Step 4: Read one existing integration test file for imports + base classes
// ---------------------------------------------------------------------------

async function readOneTestFile(
  gitClient: GitClientLike,
  repoFullName: string,
  ref: string,
  pkg: string,
  profile: TestInfraProfile
): Promise<void> {
  // Try well-known test file paths in priority order.
  const candidates = [
    `${pkg}/tests/test_instrumentor.py`,
    `${pkg}/tests/test_integration.py`,
    `${pkg}/tests/integration/test_instrumentor.py`,
    `${pkg}/tests/integration/test_integration.py`,
    `${pkg}/tests/test_tracer.py`,
    `${pkg}/tests/test_client.py`,
    `${pkg}/tests/test_span.py`,
  ];

  for (const filePath of candidates) {
    try {
      const result = await gitClient.getFileContents(repoFullName, filePath, ref);
      if (!result.ok || !result.content) continue;
      const src = result.content;

      // Record the path of the closest existing test
      profile.closestExistingTest = filePath;

      // Extract top-level import lines (lines starting with 'import' or 'from').
      const importLines = src
        .split('\n')
        .filter((line) => /^(?:import|from)\s+\S/.test(line.trim()))
        .slice(0, 40); // cap at 40 to avoid noise

      profile.existingTestImports = importLines;

      // Async marker
      if (!profile.asyncTestMarker) {
        if (/pytest\.mark\.asyncio/i.test(src)) {
          profile.asyncTestMarker = '@pytest.mark.asyncio';
        } else if (/pytest\.mark\.anyio/i.test(src)) {
          profile.asyncTestMarker = '@pytest.mark.anyio';
        }
      }

      // SDK base classes
      mergeBaseClasses(src, profile.sdkBaseClasses);

      // Additional packages
      const pkgs = extractTopLevelPackages(src);
      for (const p of pkgs) {
        if (!profile.additionalPackages.includes(p)) {
          profile.additionalPackages.push(p);
        }
      }

      break; // Stop after the first successful read
    } catch {
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract (fixtureName, bodyText) pairs from a Python source file.
 * Used to inspect the body of a fixture to look for transport/cassette usage.
 */
function extractFixtureBlocks(src: string): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  const lines = src.split('\n');
  let inFixture = false;
  let fixtureName = '';
  let bodyLines: string[] = [];
  let baseIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (/^@pytest\.fixture/.test(line)) {
      if (fixtureName && bodyLines.length > 0) {
        results.push([fixtureName, bodyLines.join('\n')]);
      }
      inFixture = true;
      fixtureName = '';
      bodyLines = [];
      baseIndent = -1;
      continue;
    }

    if (inFixture && /^def\s+(\w+)/.test(line)) {
      const match = line.match(/^def\s+(\w+)/);
      fixtureName = match ? match[1]! : '';
      baseIndent = line.search(/\S/);
      inFixture = false;
      continue;
    }

    if (fixtureName) {
      const indent = line.search(/\S/);
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      if (indent <= baseIndent && bodyLines.length > 0) {
        results.push([fixtureName, bodyLines.join('\n')]);
        fixtureName = '';
        bodyLines = [];
        baseIndent = -1;
        continue;
      }
      bodyLines.push(line);
    }
  }
  if (fixtureName && bodyLines.length > 0) {
    results.push([fixtureName, bodyLines.join('\n')]);
  }
  return results;
}

/**
 * Infer a human-readable cassette naming convention from a conftest snippet.
 */
function inferNamingConvention(snippet: string): string | null {
  // Patterns like: f"tests/cassettes/{module_name}/{test_name}.yaml"
  const fstringRe = /f["']([^"']*cassette[^"']*)['"]/i;
  const m = snippet.match(fstringRe);
  if (m) {
    const template = m[1]!.replace(/\{([^}]+)\}/g, (_, v) => `{${(v as string).trim()}}`);
    return `Path template: ${template}`;
  }

  // Patterns like: os.path.join("tests/cassettes", module, name + ".yaml")
  const joinRe = /os\.path\.join\(([^)]+)\)/;
  const jm = snippet.match(joinRe);
  if (jm) {
    return `os.path.join-based: ${jm[1]!.replace(/\s+/g, ' ').trim()}`;
  }

  // Generic: looks like it uses the test function name
  if (/request\.node\.name|request\.node\.nodeid|nodeid/i.test(snippet)) {
    return 'Named after the test function/node id (request.node.name)';
  }

  return null;
}

/**
 * Merge SDK base classes from an import section into the profile map.
 * Looks for commonly-used OTel / OpenInference SDK classes.
 */
const SDK_BASE_CLASS_PATTERNS: Array<[RegExp, string]> = [
  [/from\s+(opentelemetry\.sdk\.trace)\s+import\s+([^#\n]+)/, 'opentelemetry.sdk.trace'],
  [/from\s+(opentelemetry\.sdk\.trace\.export)\s+import\s+([^#\n]+)/, 'opentelemetry.sdk.trace.export'],
  [
    /from\s+(opentelemetry\.sdk\.trace\.export\.in_memory_span_exporter)\s+import\s+([^#\n]+)/,
    'opentelemetry.sdk.trace.export.in_memory_span_exporter',
  ],
  [/from\s+(openinference\.instrumentation)\s+import\s+([^#\n]+)/, 'openinference.instrumentation'],
  [/from\s+(opentelemetry\.trace)\s+import\s+([^#\n]+)/, 'opentelemetry.trace'],
];

function mergeBaseClasses(src: string, into: Record<string, string>): void {
  for (const [re, modulePath] of SDK_BASE_CLASS_PATTERNS) {
    const localRe = new RegExp(re.source, 'gm');
    let m: RegExpExecArray | null;
    while ((m = localRe.exec(src)) !== null) {
      const importedNames = m[2]!
        .split(',')
        .map((n) => n.trim().replace(/\s+as\s+\w+/, '').trim())
        .filter((n) => /^[A-Z][A-Za-z0-9_]*$/.test(n)); // class names (PascalCase)
      for (const name of importedNames) {
        if (!into[name]) {
          into[name] = `${modulePath}.${name}`;
        }
      }
    }
  }
}

/**
 * Extract top-level package names from import statements.
 * Returns the first-segment of the module path (e.g. "opentelemetry" from
 * "opentelemetry.sdk.trace").
 */
function extractTopLevelPackages(src: string): string[] {
  const pkgs = new Set<string>();
  const importRe = /^(?:import|from)\s+([\w.]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src)) !== null) {
    const top = m[1]!.split('.')[0];
    if (top && top !== 'typing' && top !== '__future__' && top !== 'builtins') {
      pkgs.add(top);
    }
  }
  return Array.from(pkgs);
}

/**
 * Merge pinned tool versions found in pyproject.toml into pinnedToolVersions.
 * Handles entries like `ruff==X.Y.Z` or `ruff>=X.Y.Z` in optional-dependencies
 * or dev dependency groups.
 */
function mergePinnedVersionsFromPyproject(src: string, into: Record<string, string>): void {
  const pinRe = /\b(ruff|mypy|black|isort|flake8|pylint|pytest|coverage)\s*[=><!]+\s*([\d.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pinRe.exec(src)) !== null) {
    const tool = m[1]!.toLowerCase();
    if (!into[tool]) {
      into[tool] = m[2]!;
    }
  }
}

/**
 * Parse tox.ini for pinned tool version entries in deps lines.
 * Handles lines like: `    ruff==0.9.2` or `    ruff>=0.9.0`
 */
function mergePinnedVersionsFromToxIni(src: string, into: Record<string, string>): void {
  const lineRe = /^\s*(ruff|mypy|black|isort|flake8|pylint|pytest|coverage)\s*[=><!]+\s*([\d.]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(src)) !== null) {
    const tool = m[1]!.toLowerCase();
    if (!into[tool]) {
      into[tool] = m[2]!;
    }
  }
}
