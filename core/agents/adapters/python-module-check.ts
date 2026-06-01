/**
 * Helpers for python_module_check probes.
 *
 * LLMs sometimes pass pip/distribution names (e.g.
 * `openinference-instrumentation-openai`) instead of Python import names
 * (`openinference.instrumentation.openai`). We probe a small set of normalized
 * candidates to reduce false negatives while preserving the original intent.
 */

function pushUnique(target: string[], seen: Set<string>, value: string): void {
  const trimmed = value.trim();
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  target.push(trimmed);
}

export function buildPythonImportCandidates(rawName: string): string[] {
  const trimmed = rawName.trim();
  if (!trimmed) return [];

  const bases: string[] = [];
  const baseSeen = new Set<string>();
  pushUnique(bases, baseSeen, trimmed);

  if (/[\\/]/.test(trimmed)) {
    const lastSeg = trimmed.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    if (lastSeg) pushUnique(bases, baseSeen, lastSeg);
  }

  const candidates: string[] = [];
  const candidateSeen = new Set<string>();
  for (const base of bases) {
    pushUnique(candidates, candidateSeen, base);
    if (base.includes('-')) {
      pushUnique(candidates, candidateSeen, base.replace(/-/g, '_'));
      pushUnique(candidates, candidateSeen, base.replace(/-/g, '.'));
    }
  }

  return candidates;
}

export function buildPythonModuleCheckSnippet(rawName: string): string {
  const candidates = buildPythonImportCandidates(rawName);
  return (
    `import importlib, json\n` +
    `candidates = ${JSON.stringify(candidates)}\n` +
    `last_error = None\n` +
    `for candidate in candidates:\n` +
    `  try:\n` +
    `    m = importlib.import_module(candidate)\n` +
    `    v = getattr(m, "__version__", None)\n` +
    `    print(json.dumps({"importable": True, "version": v, "module": candidate}))\n` +
    `    break\n` +
    `  except Exception as e:\n` +
    `    last_error = str(e)\n` +
    `else:\n` +
    `  print(json.dumps({"importable": False, "error": last_error or "import failed", "tried": candidates}))\n`
  );
}
