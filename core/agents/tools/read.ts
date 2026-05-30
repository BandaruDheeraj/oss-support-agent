/**
 * Read-tier tools. Side-effect free; safe to call in parallel within a turn.
 */

import { z } from 'zod';
import type { ToolDef } from './types';
import { asHandles, type GrepMatch } from './handles';

const SYMBOL_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SYMBOL_KEYWORDS = new Set([
  'class',
  'def',
  'function',
  'const',
  'let',
  'var',
  'fn',
  'interface',
  'type',
  'from',
  'import',
  'as',
  'self',
]);

function escapeRegexLiteral(value: string): string {
  return value.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
}

function dedupeMatches(matches: GrepMatch[]): GrepMatch[] {
  const seen = new Set<string>();
  const out: GrepMatch[] = [];
  for (const match of matches) {
    const key = `${match.path}:${match.line}:${match.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(match);
  }
  return out;
}

function buildAlternation(candidates: string[]): string {
  return candidates.map((candidate) => escapeRegexLiteral(candidate)).join('|');
}

async function searchSymbolDefinitions(
  patternCandidates: string[],
  workspace: ReturnType<typeof asHandles>['workspace'],
  paths?: string[],
): Promise<GrepMatch[]> {
  if (patternCandidates.length === 0) return [];
  const alternation = buildAlternation(patternCandidates);
  // Use grep -E compatible syntax (POSIX classes) — no PCRE \b/\s/non-capturing groups.
  const pattern =
    `(^|[[:space:]])(class|def|function|const|let|var|fn|interface|type)` +
    `[[:space:]]+(${alternation})([^[:alnum:]_]|$)`;
  const defs = await workspace.grep(pattern, paths, { caseInsensitive: false });
  if (defs.length > 0) return dedupeMatches(defs);
  const fallbackPattern = `(^|[^[:alnum:]_])(${alternation})([^[:alnum:]_]|$)`;
  return dedupeMatches(
    await workspace.grep(fallbackPattern, paths, {
      caseInsensitive: false,
    }),
  );
}

async function searchSymbolCallers(
  patternCandidates: string[],
  workspace: ReturnType<typeof asHandles>['workspace'],
  paths?: string[],
): Promise<GrepMatch[]> {
  if (patternCandidates.length === 0) return [];
  const alternation = buildAlternation(patternCandidates);
  const pattern = `(^|[^[:alnum:]_])(${alternation})[[:space:]]*\\(`;
  const callers = await workspace.grep(pattern, paths, { caseInsensitive: false });
  if (callers.length > 0) return dedupeMatches(callers);
  const fallbackPattern = `(^|[^[:alnum:]_])(${alternation})([^[:alnum:]_]|$)`;
  return dedupeMatches(
    await workspace.grep(fallbackPattern, paths, {
      caseInsensitive: false,
    }),
  );
}

function lineContext(content: string | null, line: number, radius: number): string | null {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  if (line < 1 || line > lines.length) return null;
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return lines
    .slice(start - 1, end)
    .map((text, idx) => `${start + idx}: ${text}`)
    .join('\n');
}

async function enrichWithContext(
  matches: GrepMatch[],
  workspace: ReturnType<typeof asHandles>['workspace'],
  contextLines: number,
): Promise<Array<GrepMatch & { context: string | null }>> {
  if (matches.length === 0) return [];
  const uniquePaths = Array.from(new Set(matches.map((m) => m.path)));
  const contentByPath = new Map<string, string | null>();
  await Promise.all(
    uniquePaths.map(async (path) => {
      contentByPath.set(path, await workspace.readFile(path));
    }),
  );
  return matches.map((match) => ({
    ...match,
    context: lineContext(contentByPath.get(match.path) ?? null, match.line, contextLines),
  }));
}

/**
 * Convert free-form symbol text (qualified names, call-form snippets) into
 * identifier candidates suitable for grep -E lookup.
 */
export function extractSymbolSearchCandidates(rawSymbol: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (token: string): void => {
    const value = token.trim();
    if (!SYMBOL_TOKEN_RE.test(value)) return;
    if (SYMBOL_KEYWORDS.has(value.toLowerCase())) return;
    if (seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };

  const stripped = rawSymbol.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!stripped) return [];

  // If input looks like a call expression, strip argument tail.
  const noArgs = stripped.replace(/\(.*$/, '');
  const roughTokens = noArgs
    .split(/[\s,=:+\-*/\\<>!~]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  for (const token of roughTokens) {
    const normalized = token.replace(/::/g, '.').replace(/->/g, '.');
    const pieces = normalized
      .split('.')
      .map((piece) => piece.replace(/^[^A-Za-z_]+|[^A-Za-z0-9_]+$/g, ''))
      .filter(Boolean);
    for (let i = pieces.length - 1; i >= 0; i -= 1) add(pieces[i]);
  }

  const identifiers = stripped.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  for (let i = identifiers.length - 1; i >= 0; i -= 1) add(identifiers[i]);
  return out.slice(0, 10);
}

const FilePath = z.object({ path: z.string().min(1) }).strict();

export const readFile: ToolDef<z.infer<typeof FilePath>, { content: string | null }> = {
  name: 'read_file',
  tier: 'read',
  description: 'Read a file from the repository workspace.',
  parameters: FilePath,
  async execute({ path }, ctx) {
    const content = await asHandles(ctx.handles).workspace.readFile(path);
    return { content };
  },
};

const ListDir = z.object({ path: z.string().min(1).default('.') }).strict();
export const listDir: ToolDef<z.infer<typeof ListDir>, { entries: { name: string; isDir: boolean }[] }> = {
  name: 'list_dir',
  tier: 'read',
  description: 'List entries in a directory (non-recursive).',
  parameters: ListDir,
  async execute({ path }, ctx) {
    const entries = await asHandles(ctx.handles).workspace.listDir(path);
    return { entries };
  },
};

const Grep = z
  .object({
    pattern: z.string().min(1),
    paths: z.array(z.string()).optional(),
    caseInsensitive: z.boolean().optional(),
  })
  .strict();
export const grep: ToolDef<z.infer<typeof Grep>, { matches: Awaited<ReturnType<NonNullable<ReturnType<typeof asHandles>['workspace']['grep']>>> }> = {
  name: 'grep',
  tier: 'read',
  description: 'Search files for a regex pattern; returns file:line:text matches.',
  parameters: Grep,
  async execute({ pattern, paths, caseInsensitive }, ctx) {
    const matches = await asHandles(ctx.handles).workspace.grep(pattern, paths, {
      caseInsensitive: !!caseInsensitive,
    });
    return { matches };
  },
};

const ReadDiff = z.object({}).strict();
export const readDiff: ToolDef<z.infer<typeof ReadDiff>, { diff: string }> = {
  name: 'read_diff',
  tier: 'read',
  description: 'Show the current diff of the working branch vs the baseline.',
  parameters: ReadDiff,
  async execute(_args, ctx) {
    const diff = await asHandles(ctx.handles).workspace.readDiff();
    return { diff };
  },
};

const GitLog = z.object({ path: z.string().optional(), n: z.number().int().min(1).max(50).default(10) }).strict();
export const gitLog: ToolDef<z.infer<typeof GitLog>, unknown> = {
  name: 'git_log',
  tier: 'read',
  description: 'Show recent commits, optionally scoped to a path.',
  parameters: GitLog,
  async execute({ path, n }, ctx) {
    return { entries: await asHandles(ctx.handles).workspace.gitLog(path, n) };
  },
};

const GitBlame = z
  .object({ path: z.string().min(1), lineStart: z.number().int().optional(), lineEnd: z.number().int().optional() })
  .strict();
export const gitBlame: ToolDef<z.infer<typeof GitBlame>, unknown> = {
  name: 'git_blame',
  tier: 'read',
  description: 'Show git blame for a file, optionally for a line range.',
  parameters: GitBlame,
  async execute({ path, lineStart, lineEnd }, ctx) {
    return { lines: await asHandles(ctx.handles).workspace.gitBlame(path, lineStart, lineEnd) };
  },
};

const ReadTest = z.object({ path: z.string().min(1) }).strict();
export const readTest: ToolDef<z.infer<typeof ReadTest>, unknown> = {
  name: 'read_test',
  tier: 'read',
  description: 'Read a test file (alias for read_file, but emphasises intent in transcripts).',
  parameters: ReadTest,
  async execute({ path }, ctx) {
    const content = await asHandles(ctx.handles).workspace.readFile(path);
    return { content };
  },
};

const FindSymbol = z.object({ symbol: z.string().min(1), paths: z.array(z.string()).optional() }).strict();
export const findSymbol: ToolDef<z.infer<typeof FindSymbol>, unknown> = {
  name: 'find_symbol',
  tier: 'read',
  description: 'Find a symbol definition (regex search for class/def/function/const).',
  parameters: FindSymbol,
  async execute({ symbol, paths }, ctx) {
    const candidates = extractSymbolSearchCandidates(symbol);
    if (candidates.length === 0) return { matches: [] };
    return { matches: await searchSymbolDefinitions(candidates, asHandles(ctx.handles).workspace, paths) };
  },
};

const FindCallers = z.object({ symbol: z.string().min(1), paths: z.array(z.string()).optional() }).strict();
export const findCallers: ToolDef<z.infer<typeof FindCallers>, unknown> = {
  name: 'find_callers',
  tier: 'read',
  description: 'Find call sites for a symbol (regex search for `symbol(`).',
  parameters: FindCallers,
  async execute({ symbol, paths }, ctx) {
    const candidates = extractSymbolSearchCandidates(symbol);
    if (candidates.length === 0) return { matches: [] };
    return { matches: await searchSymbolCallers(candidates, asHandles(ctx.handles).workspace, paths) };
  },
};

const WebFetch = z.object({ url: z.string().url(), maxBytes: z.number().int().min(256).max(200_000).default(20_000) }).strict();
export const webFetch: ToolDef<z.infer<typeof WebFetch>, unknown> = {
  name: 'web_fetch',
  tier: 'read',
  description: 'Fetch a URL (text); use sparingly for upstream docs / external refs.',
  parameters: WebFetch,
  async execute({ url, maxBytes }) {
    try {
      const res = await fetch(url, { method: 'GET' });
      const text = await res.text();
      return { status: res.status, content: text.slice(0, maxBytes), truncated: text.length > maxBytes };
    } catch (err) {
      return { status: 0, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const GhIssue = z.object({}).strict();
export const ghIssue: ToolDef<z.infer<typeof GhIssue>, unknown> = {
  name: 'gh_issue',
  tier: 'read',
  description: 'Return the upstream issue context this agent is working on.',
  parameters: GhIssue,
  async execute(_args, ctx) {
    return asHandles(ctx.handles).issue;
  },
};

const GhPr = z.object({}).strict();
export const ghPr: ToolDef<z.infer<typeof GhPr>, unknown> = {
  name: 'gh_pr',
  tier: 'read',
  description: 'Return the repository context including affected_module and fork.',
  parameters: GhPr,
  async execute(_args, ctx) {
    return asHandles(ctx.handles).repo;
  },
};

const ReadIssueRepoContext = z.object({ includeBody: z.boolean().default(true) }).strict();
export const readIssueRepoContext: ToolDef<
  z.infer<typeof ReadIssueRepoContext>,
  { issue: { number: number; title: string; labels: string[]; url: string; body?: string }; repo: ReturnType<typeof asHandles>['repo'] }
> = {
  name: 'read_issue_repo_context',
  tier: 'read',
  description: 'Fetch issue + repository metadata in one call.',
  parameters: ReadIssueRepoContext,
  async execute({ includeBody }, ctx) {
    const handles = asHandles(ctx.handles);
    return {
      issue: includeBody
        ? handles.issue
        : {
            number: handles.issue.number,
            title: handles.issue.title,
            labels: handles.issue.labels,
            url: handles.issue.url,
          },
      repo: handles.repo,
    };
  },
};

const GrepWithContext = z
  .object({
    pattern: z.string().min(1),
    paths: z.array(z.string()).optional(),
    caseInsensitive: z.boolean().optional(),
    maxMatches: z.number().int().min(1).max(200).default(30),
    contextLines: z.number().int().min(0).max(20).default(2),
  })
  .strict();
export const grepWithContext: ToolDef<z.infer<typeof GrepWithContext>, unknown> = {
  name: 'grep_with_context',
  tier: 'read',
  description: 'Search files and include surrounding line context snippets in one call.',
  parameters: GrepWithContext,
  async execute({ pattern, paths, caseInsensitive, maxMatches, contextLines }, ctx) {
    const workspace = asHandles(ctx.handles).workspace;
    const rawMatches = dedupeMatches(
      await workspace.grep(pattern, paths, {
        caseInsensitive: !!caseInsensitive,
      }),
    );
    const limited = rawMatches.slice(0, maxMatches);
    return {
      pattern,
      truncated: rawMatches.length > maxMatches,
      matches: await enrichWithContext(limited, workspace, contextLines),
    };
  },
};

const ReadSymbolContext = z
  .object({
    symbol: z.string().min(1),
    paths: z.array(z.string()).optional(),
    includeCallers: z.boolean().default(true),
    maxDefinitions: z.number().int().min(1).max(80).default(10),
    maxCallers: z.number().int().min(0).max(200).default(25),
    contextLines: z.number().int().min(0).max(20).default(3),
  })
  .strict();
export const readSymbolContext: ToolDef<z.infer<typeof ReadSymbolContext>, unknown> = {
  name: 'read_symbol_context',
  tier: 'read',
  description: 'Resolve symbol definitions + callers with snippets in one call.',
  parameters: ReadSymbolContext,
  async execute(
    { symbol, paths, includeCallers, maxDefinitions, maxCallers, contextLines },
    ctx,
  ) {
    const workspace = asHandles(ctx.handles).workspace;
    const candidates = extractSymbolSearchCandidates(symbol);
    if (candidates.length === 0) {
      return {
        symbol,
        candidates: [],
        definitions: [],
        callers: [],
      };
    }
    const allDefs = await searchSymbolDefinitions(candidates, workspace, paths);
    const definitions = await enrichWithContext(allDefs.slice(0, maxDefinitions), workspace, contextLines);

    let callers: Array<GrepMatch & { context: string | null }> = [];
    let callerTruncated = false;
    if (includeCallers) {
      const allCallers = await searchSymbolCallers(candidates, workspace, paths);
      callerTruncated = allCallers.length > maxCallers;
      callers = await enrichWithContext(allCallers.slice(0, maxCallers), workspace, contextLines);
    }

    return {
      symbol,
      candidates,
      definitions,
      callers,
      truncated: {
        definitions: allDefs.length > maxDefinitions,
        callers: callerTruncated,
      },
    };
  },
};

const ReadEvidence = z
  .object({
    snapshotId: z.string().optional(),
    evidenceId: z.string().optional(),
  })
  .strict();
export const readEvidence: ToolDef<z.infer<typeof ReadEvidence>, unknown> = {
  name: 'read_evidence',
  tier: 'read',
  description: 'Read the current EvidenceDossier (latest snapshot by default).',
  parameters: ReadEvidence,
  async execute({ snapshotId, evidenceId }, ctx) {
    const dossier = asHandles(ctx.handles).dossier;
    if (!dossier) return { error: 'no dossier attached to this agent context' };
    const snap = snapshotId ? dossier.get(snapshotId) : dossier.latest();
    if (!snap) return { error: 'no dossier snapshot available' };
    if (evidenceId) {
      return { snapshot_id: snap.snapshotId, evidence: snap.body.evidence.find((e) => e.id === evidenceId) };
    }
    return { snapshot_id: snap.snapshotId, body: snap.body };
  },
};

const ReadNotes = z.object({ snapshotId: z.string().optional() }).strict();
export const readInvestigationNotes: ToolDef<z.infer<typeof ReadNotes>, unknown> = {
  name: 'read_investigation_notes',
  tier: 'read',
  description: 'Read the FixInvestigationNotes; pass a dossier snapshot id to filter.',
  parameters: ReadNotes,
  async execute({ snapshotId }, ctx) {
    const notes = asHandles(ctx.handles).notes;
    if (!notes) return { error: 'no investigation notes available' };
    if (snapshotId) return { notes: notes.forSnapshot(snapshotId) };
    return { latest: notes.latest() };
  },
};

export const READ_TOOLS = [
  readFile,
  listDir,
  grep,
  readDiff,
  gitLog,
  gitBlame,
  readTest,
  findSymbol,
  findCallers,
  webFetch,
  ghIssue,
  ghPr,
  readIssueRepoContext,
  grepWithContext,
  readSymbolContext,
  readEvidence,
  readInvestigationNotes,
] as const;
