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
  /** e.g. "tests/cassettes/{module}/{name}.yaml" */
  cassetteDir: string | null;
  /** Human description of the naming rule inferred from conftest.py */
  cassetteNamingConvention: string | null;
  /** e.g. "cassette_transport" – the fixture name that injects the transport */
  cassetteTransportFixture: string | null;
  /** Existing cassette names without extension, e.g. ["test_chat", "test_stream"] */
  existingCassettes: string[];

  /** All @pytest.fixture names found in conftest.py */
  availableFixtures: string[];

  /** pip extras from [project.optional-dependencies], e.g. ["test", "instruments"] */
  testExtras: string[];
  /** Packages inferred from conftest.py top-level imports */
  additionalTestPackages: string[];

  /**
   * Map of class-name → import-path for SDK base classes seen in conftest or
   * test imports, e.g. { SpanProcessor: "opentelemetry.sdk.trace.SpanProcessor" }
   */
  sdkBaseClasses: Record<string, string>;
  /** e.g. "@pytest.mark.asyncio" */
  asyncTestMarker: string | null;

  /** Top-level import lines from one existing test file */
  existingTestImports: string[];

  /** e.g. { ruff: "0.9.2" } from tox.ini or pyproject.toml */
  lintToolVersions: Record<string, string>;
}

export interface FingerprintArgs {
  gitClient: {
    getFileContents(
      repoFullName: string,
      path: string,
      ref: string
    ): Promise<{ ok: boolean; content?: string }>;
  };
  repoFullName: string;
  ref: string;
  /** e.g. "python/instrumentation/openinference-instrumentation-claude-agent-sdk" */
  affectedPackagePath: string;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fingerPrintTestInfra(args: FingerprintArgs): Promise<TestInfraProfile> {
  const { gitClient, repoFullName, ref, affectedPackagePath } = args;
  const pkg = affectedPackagePath.replace(/\/$/, '');

  const profile: TestInfraProfile = {
    cassetteDir: null,
    cassetteNamingConvention: null,
    cassetteTransportFixture: null,
    existingCassettes: [],
    availableFixtures: [],
    testExtras: [],
    additionalTestPackages: [],
    sdkBaseClasses: {},
    asyncTestMarker: null,
    existingTestImports: [],
    lintToolVersions: {},
  };

  // Run all reads concurrently; each is independently try/caught.
  await Promise.all([
    parseConftest(gitClient, repoFullName, ref, pkg, profile),
    parsePyproject(gitClient, repoFullName, ref, pkg, profile),
    parseToxIni(gitClient, repoFullName, ref, pkg, profile),
    listCassettes(gitClient, repoFullName, ref, pkg, profile),
    readOneTestFile(gitClient, repoFullName, ref, pkg, profile),
  ]);

  return profile;
}

// ---------------------------------------------------------------------------
// Step 1: Parse conftest.py
// ---------------------------------------------------------------------------

async function parseConftest(
  gitClient: FingerprintArgs['gitClient'],
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
    // object. Heuristic: fixture whose body mentions "ReplayTransport",
    // "VCR", "cassette", or "transport" and is not a path function.
    const cassetteFxRe =
      /^@pytest\.fixture(?:\([^)]*\))?\s*\ndef\s+(\w*(?:transport|cassette|vcr|replay)\w*)\b/gim;
    while ((m = cassetteFxRe.exec(src)) !== null) {
      // Prefer the first match — there's usually only one.
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

    // --- Cassette path / naming convention -----------------------------------
    // Look for a function like `_cassette_path`, `cassette_path`, etc.
    const cassettePathFnRe =
      /def\s+(\w*cassette_path\w*)\s*\([^)]*\)[\s\S]*?(?=\ndef |\nclass |\Z)/gi;
    const cassettePathFnAlt =
      /def\s+(get_cassette_path|cassette_name|_cassette_name)\s*\([^)]*\)/gi;

    let cassetteDirRaw: string | null = null;
    let cassetteConvention: string | null = null;

    for (const re of [cassettePathFnRe, cassettePathFnAlt]) {
      m = re.exec(src);
      if (m) {
        // Extract the body of the function (crude: up to 20 lines)
        const startIdx = m.index;
        const snippet = src.slice(startIdx, startIdx + 1200);
        // Try to extract the cassette dir from path joins / f-strings
        const dirMatch =
          snippet.match(/['"](tests\/cassettes[^'"]*)['"]/i) ??
          snippet.match(/os\.path\.join\(([^)]+)\)/i) ??
          snippet.match(/Path\(([^)]+)\)/i);
        if (dirMatch) {
          cassetteDirRaw = dirMatch[1].replace(/\s+/g, '');
        }
        cassetteConvention = inferNamingConvention(snippet);
        break;
      }
    }

    // Fallback: scan src for any string that looks like a cassette directory.
    if (!cassetteDirRaw) {
      const pathLiteralRe = /['"]([^'"]*cassettes[^'"]*)['"]/gi;
      while ((m = pathLiteralRe.exec(src)) !== null) {
        const candidate = m[1];
        if (candidate.includes('/') && !candidate.startsWith('http')) {
          cassetteDirRaw = candidate;
          break;
        }
      }
    }

    if (cassetteDirRaw) {
      profile.cassetteDir = cassetteDirRaw;
    }
    if (cassetteConvention) {
      profile.cassetteNamingConvention = cassetteConvention;
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
    for (const pkg of importedPackages) {
      if (!profile.additionalTestPackages.includes(pkg)) {
        profile.additionalTestPackages.push(pkg);
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
  gitClient: FingerprintArgs['gitClient'],
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
    // Match the section header and collect the keys (extras names).
    const optDepsSectionRe =
      /\[project\.optional-dependencies\]([\s\S]*?)(?=^\[|\z)/m;
    const sectionMatch = src.match(optDepsSectionRe);
    if (sectionMatch) {
      const sectionBody = sectionMatch[1];
      // Each extra is a key = [ ... ] block
      const extraKeyRe = /^(\w[\w-]*)\s*=/gm;
      let m: RegExpExecArray | null;
      while ((m = extraKeyRe.exec(sectionBody)) !== null) {
        const extraName = m[1];
        if (!profile.testExtras.includes(extraName)) {
          profile.testExtras.push(extraName);
        }
      }
    }

    // --- Ruff / lint tool versions from [tool.ruff] -------------------------
    mergeRuffVersionFromPyproject(src, profile.lintToolVersions);

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
// Step 3: Parse tox.ini for lint tool versions
// ---------------------------------------------------------------------------

async function parseToxIni(
  gitClient: FingerprintArgs['gitClient'],
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
    mergeLintVersionsFromToxIni(src, profile.lintToolVersions);
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Step 4: List existing cassettes using GitHub contents API (tree walk)
// ---------------------------------------------------------------------------

async function listCassettes(
  gitClient: FingerprintArgs['gitClient'],
  repoFullName: string,
  ref: string,
  pkg: string,
  profile: TestInfraProfile
): Promise<void> {
  // We use getFileContents on candidate directory paths to enumerate cassettes.
  // GitHub's contents API returns an array when the path is a directory.
  // Our gitClient.getFileContents interface returns {ok, content?} where content
  // is a decoded string. For directories the response from getFileContents will
  // typically not be ok (404 or the client returns ok:false for directories).
  //
  // Strategy: attempt to GET the cassettes directory as a directory listing.
  // Since FingerprintArgs.gitClient only exposes getFileContents (single file),
  // we need to list cassette YAML files by fetching the GitHub contents API
  // directly. However, we only have the gitClient interface — so we try a few
  // well-known cassette sub-paths from the profile (or defaults) and record
  // names from successful reads.
  //
  // More robustly: extend the gitClient interface inline to call GitHub
  // /repos/:owner/:repo/contents/:path?ref= and parse the JSON array.
  // But since we only have getFileContents, we'll use a supplementary fetch
  // call if the environment has GITHUB_TOKEN, falling back to an empty list.

  try {
    const cassetteBasePaths = profile.cassetteDir
      ? [profile.cassetteDir]
      : [
          `${pkg}/tests/cassettes`,
          `${pkg}/tests/cassettes/integration`,
          `${pkg}/tests/fixtures/cassettes`,
        ];

    const names: string[] = [];

    for (const basePath of cassetteBasePaths) {
      const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? '';
      if (!token) continue;

      // Call GitHub contents API with Accept: application/json to get a dir listing.
      const cleanPath = basePath.replace(/^\/+|\/+$/g, '');
      const url = `https://api.github.com/repos/${repoFullName}/contents/${cleanPath}?ref=${encodeURIComponent(ref)}`;
      try {
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'oss-support-agent',
          },
        });
        if (!res.ok) continue;
        const data = (await res.json()) as unknown;
        if (!Array.isArray(data)) continue;

        for (const entry of data as Array<{ name?: string; type?: string }>) {
          if (entry.type === 'file' && typeof entry.name === 'string') {
            const n = entry.name.replace(/\.(yaml|yml|json|json\.gz)$/i, '');
            if (!names.includes(n)) names.push(n);
          }
        }
        if (names.length > 0) break; // found cassettes — stop iterating paths
      } catch {
        // network failure or JSON parse error — skip this path
        continue;
      }
    }

    profile.existingCassettes = names;

    // Update cassetteDir if we found cassettes at a path we didn't know before.
    if (names.length > 0 && !profile.cassetteDir) {
      profile.cassetteDir = `${pkg}/tests/cassettes`;
    }
  } catch {
    // best effort
  }
}

// ---------------------------------------------------------------------------
// Step 5: Read one existing integration test file
// ---------------------------------------------------------------------------

async function readOneTestFile(
  gitClient: FingerprintArgs['gitClient'],
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
        if (!profile.additionalTestPackages.includes(p)) {
          profile.additionalTestPackages.push(p);
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
    const line = lines[i];

    if (/^@pytest\.fixture/.test(line)) {
      // Next def is a fixture
      inFixture = true;
      if (fixtureName && bodyLines.length > 0) {
        results.push([fixtureName, bodyLines.join('\n')]);
      }
      fixtureName = '';
      bodyLines = [];
      baseIndent = -1;
      continue;
    }

    if (inFixture && /^def\s+(\w+)/.test(line)) {
      const match = line.match(/^def\s+(\w+)/);
      fixtureName = match ? match[1] : '';
      baseIndent = line.search(/\S/); // indentation of the def line (should be 0 for top-level)
      inFixture = false; // reset so we don't catch the next @pytest.fixture
      continue;
    }

    if (fixtureName) {
      const indent = line.search(/\S/);
      if (line.trim() === '') {
        bodyLines.push(line);
        continue;
      }
      // If we encounter a line at or less indentation than the def, the fixture body is over.
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
    // Normalise Python f-string variables to {variable} style
    const template = m[1].replace(/\{([^}]+)\}/g, (_, v) => `{${v.trim()}}`);
    return `Path template: ${template}`;
  }

  // Patterns like: os.path.join("tests/cassettes", module, name + ".yaml")
  const joinRe = /os\.path\.join\(([^)]+)\)/;
  const jm = snippet.match(joinRe);
  if (jm) {
    return `os.path.join-based: ${jm[1].replace(/\s+/g, ' ').trim()}`;
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
const SDK_BASE_CLASS_PATTERNS: Array<[RegExp, string, string]> = [
  [/from\s+(opentelemetry\.sdk\.trace)\s+import\s+([^#\n]+)/, 'opentelemetry.sdk.trace', ''],
  [/from\s+(opentelemetry\.sdk\.trace\.export)\s+import\s+([^#\n]+)/, 'opentelemetry.sdk.trace.export', ''],
  [/from\s+(opentelemetry\.sdk\.trace\.export\.in_memory_span_exporter)\s+import\s+([^#\n]+)/, 'opentelemetry.sdk.trace.export.in_memory_span_exporter', ''],
  [/from\s+(openinference\.instrumentation)\s+import\s+([^#\n]+)/, 'openinference.instrumentation', ''],
  [/from\s+(opentelemetry\.trace)\s+import\s+([^#\n]+)/, 'opentelemetry.trace', ''],
];

function mergeBaseClasses(src: string, into: Record<string, string>): void {
  for (const [re, modulePath] of SDK_BASE_CLASS_PATTERNS) {
    let m: RegExpExecArray | null;
    const localRe = new RegExp(re.source, 'gm');
    while ((m = localRe.exec(src)) !== null) {
      const importedNames = m[2]
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
    const top = m[1].split('.')[0];
    if (top && top !== 'typing' && top !== '__future__' && top !== 'builtins') {
      pkgs.add(top);
    }
  }
  return Array.from(pkgs);
}

/**
 * Merge ruff/mypy/black version pins found in pyproject.toml into lintToolVersions.
 * Handles [tool.ruff], [[tool.mypy]], etc.
 */
function mergeRuffVersionFromPyproject(src: string, into: Record<string, string>): void {
  // Look for `ruff>=X.Y.Z` or `ruff==X.Y.Z` in optional-dependencies or
  // dev dependencies.
  const pinRe = /\b(ruff|mypy|black|isort|flake8|pylint)\s*[=><!]+\s*([\d.]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = pinRe.exec(src)) !== null) {
    const tool = m[1].toLowerCase();
    if (!into[tool]) {
      into[tool] = m[2];
    }
  }
}

/**
 * Parse tox.ini for lint tool version pins in deps lines.
 * Handles lines like: `    ruff==0.9.2` or `    ruff>=0.9.0`
 */
function mergeLintVersionsFromToxIni(src: string, into: Record<string, string>): void {
  const lineRe = /^\s*(ruff|mypy|black|isort|flake8|pylint)\s*[=><!]+\s*([\d.]+)/gim;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(src)) !== null) {
    const tool = m[1].toLowerCase();
    if (!into[tool]) {
      into[tool] = m[2];
    }
  }
}
