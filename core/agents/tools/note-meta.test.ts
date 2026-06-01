/**
 * Regression tests for the schema-relaxation + server-side defaulting in
 * record_evidence / write_investigation_notes. These guard against the
 * exact failure mode seen on issue #46: the LLM dropped the required
 * `source` field, Vercel AI SDK's pre-execute Zod parse rejected the
 * call, and the entire Analyst loop terminated with `error` without ever
 * producing a dossier.
 *
 * The fix relies on three properties:
 *   1. EvidenceInputSchema accepts missing `source` (no parse failure).
 *   2. record_evidence.execute stamps a meaningful default by `kind`.
 *   3. write_investigation_notes does the same for findings[].recordedAt.
 */

import { recordEvidence, writeInvestigationNotes } from './note-meta';
import { DossierStore } from '../analyst/dossier';
import { InvestigationNotesStore } from '../fix-loop/investigation-notes';
import type { ToolContext } from './types';

function ctxFor(handles: Record<string, unknown>, opts?: { dossierSnapshotId?: string }): ToolContext {
  return {
    agentName: 'ANALYST',
    attemptId: 'attempt-test',
    issueNumber: 42,
    handles,
    dossierSnapshotId: opts?.dossierSnapshotId,
    recordTranscript: () => undefined,
    getTranscript: () => [],
  };
}

describe('record_evidence — server-stamped source defaults', () => {
  it('accepts evidence items with no `source` and stamps issue#N for issue_excerpt', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'e1',
            kind: 'issue_excerpt',
            summary: 'crash on NonRecordingSpan',
          } as any,
        ],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'analysis summary',
        confidence: 'medium',
      },
      ctxFor({ dossier })
    );
    const snap = dossier.latest();
    expect(snap).not.toBeNull();
    expect(snap!.body.evidence[0].source).toBe('issue#42');
    expect(snap!.body.evidence[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fills default summary/confidence when omitted', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'e1',
            kind: 'issue_excerpt',
            summary: 'stack trace points to wrapper',
          } as any,
        ],
        suspectSymbols: [
          {
            file: 'src/pkg/mod.py',
            symbol: 'pkg.mod.func',
            reasoning: 'traceback points to this wrapper',
          },
        ],
        openQuestions: [],
        preconditions: [],
      } as any,
      ctxFor({ dossier })
    );
    const snap = dossier.latest();
    expect(snap).not.toBeNull();
    expect(snap!.body.summary).toContain('Recorded 1 evidence item');
    expect(snap!.body.confidence).toBe('low');
  });

  it('uses semantic seed as primary suspectFiles/suspectSymbols when analyst omits them', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'seeded',
        confidence: 'medium',
      },
      ctxFor({
        dossier,
        semanticSuspectSeed: {
          model: 'BAAI/bge-small-en-v1.5',
          query: 'issue query',
          cacheHit: true,
          cacheKey: 'abc',
          indexedFileCount: 10,
          instrumentationDirs: ['python/instrumentation'],
          suspectFiles: ['python/instrumentation/pkg/mod.py'],
          suspectSymbols: [
            {
              file: 'python/instrumentation/pkg/mod.py',
              symbol: 'Instrumentor',
              reasoning: 'semantic hit',
            },
          ],
          semanticConfidence: {
            top_score: 0.41,
            low_confidence: true,
            diagnostics: 'semantic top_score=0.410 below threshold 0.600; suspects are low-confidence',
          },
        },
      })
    );

    const snap = dossier.latest();
    expect(snap).not.toBeNull();
    expect(snap!.body.suspectFiles).toEqual(['python/instrumentation/pkg/mod.py']);
    expect(snap!.body.suspectSymbols).toEqual([
      {
        file: 'python/instrumentation/pkg/mod.py',
        symbol: 'Instrumentor',
        reasoning: 'semantic hit',
      },
    ]);
    expect(snap!.body.semanticConfidence).toEqual({
      top_score: 0.41,
      low_confidence: true,
      diagnostics: 'semantic top_score=0.410 below threshold 0.600; suspects are low-confidence',
    });
  });

  it('derives oracleSpec when omitted from suspectSymbols + preconditions', async () => {
    const dossier = new DossierStore();
    const res = await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [
          {
            file: 'src/pkg/mod.py',
            symbol: 'pkg.mod.finalize',
            reasoning: 'stack trace points here',
          },
        ],
        openQuestions: [],
        preconditions: [
          {
            id: 'pc-0',
            condition: 'no tracer provider configured',
            kind: 'config_absence',
            evidenceRefs: [],
            satisfactionModes: [
              { description: 'direct call', markers: ['NonRecordingSpan('] },
            ],
            threats: [],
          },
        ],
        summary: 'analysis summary',
        confidence: 'high',
      },
      ctxFor({ dossier })
    );
    expect((res as any).oracle_spec_recorded).toBe(true);
    expect(dossier.latest()!.body.oracleSpec).toEqual({
      suspect_path_assertions: [
        { kind: 'symbol', needle: 'pkg.mod.finalize', file: 'src/pkg/mod.py' },
      ],
      precondition_assertions: [
        {
          condition: 'no tracer provider configured',
          markers: ['NonRecordingSpan('],
        },
      ],
    });
  });

  it('normalizes and persists explicit oracleSpec from tool input', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'analysis summary',
        confidence: 'high',
        oracleSpec: {
          suspect_path_assertions: [
            ' finalize_span ',
            { kind: 'stack frame', match: 'src/foo.py:42' },
          ],
          precondition_assertions: [
            { condition: 'env var FOO unset', markers: ['FOO not in os.environ'] },
          ],
        } as any,
      },
      ctxFor({ dossier })
    );
    expect(dossier.latest()!.body.oracleSpec).toEqual({
      suspect_path_assertions: [
        { kind: 'symbol', needle: 'finalize_span' },
        { kind: 'stack_frame', needle: 'src/foo.py:42' },
      ],
      precondition_assertions: [
        {
          condition: 'env var FOO unset',
          markers: ['FOO not in os.environ'],
        },
      ],
    });
  });

  it('uses attrs.file for file_excerpt / symbol_definition / symbol_caller', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'f1',
            kind: 'file_excerpt',
            summary: 'finalize span code',
            attrs: { file: 'src/x.py' },
          } as any,
          {
            id: 's1',
            kind: 'symbol_definition',
            summary: 'def foo',
            attrs: { file: 'src/y.py' },
          } as any,
          {
            id: 'c1',
            kind: 'symbol_caller',
            summary: 'foo() called',
            attrs: { file: 'src/z.py' },
          } as any,
        ],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'multi-kind evidence',
        confidence: 'low',
      },
      ctxFor({ dossier })
    );
    const ev = dossier.latest()!.body.evidence;
    expect(ev[0].source).toBe('src/x.py');
    expect(ev[1].source).toBe('src/y.py');
    expect(ev[2].source).toBe('src/z.py');
  });

  it('falls back to unknown:<kind> when attrs.file is absent', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'f1',
            kind: 'file_excerpt',
            summary: 'no file attr',
          } as any,
        ],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 's',
        confidence: 'low',
      },
      ctxFor({ dossier })
    );
    expect(dossier.latest()!.body.evidence[0].source).toBe('unknown:file_excerpt');
  });

  it('preserves explicit source when LLM does provide one', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'a',
            kind: 'web_reference',
            source: 'https://example.com/x',
            summary: 'doc',
          } as any,
        ],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 's',
        confidence: 'low',
      },
      ctxFor({ dossier })
    );
    expect(dossier.latest()!.body.evidence[0].source).toBe('https://example.com/x');
  });

  it('uses attrs.sha for recent_commit and attrs.url for web_reference', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [
          {
            id: 'r1',
            kind: 'recent_commit',
            summary: 'recent change',
            attrs: { sha: 'abc1234' },
          } as any,
          {
            id: 'w1',
            kind: 'web_reference',
            summary: 'doc',
            attrs: { url: 'https://docs.example.com/page' },
          } as any,
        ],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 's',
        confidence: 'low',
      },
      ctxFor({ dossier })
    );
    const ev = dossier.latest()!.body.evidence;
    expect(ev[0].source).toBe('abc1234');
    expect(ev[1].source).toBe('https://docs.example.com/page');
  });
});

describe('record_evidence — reproRecipe passthrough', () => {
  it('persists a well-formed recipe and stamps recordedAt when missing', async () => {
    const dossier = new DossierStore();
    const res = await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'prober result',
        confidence: 'high',
        reproRecipe: {
          candidateTestPath: 'tests/repro_46.py',
          testSource: 'def test_x():\n    assert False  # SENTINEL_46\n',
          sentinelString: 'SENTINEL_46',
          expectedFailureSignature: 'AssertionError',
          pipInstalls: [{ package: 'openinference-instrumentation-smolagents', editable: true }],
          requiresCredentials: ['OPENAI_API_KEY'],
          verbatimSnippetIncompatible: true,
          provenance: {
            exerciseImports: ['openinference.instrumentation.smolagents'],
            preconditionsSatisfied: ['pc-0'],
            observedProbe: {
              sentinelObserved: true,
              signatureObserved: true,
              exitCode: 1,
              durationMs: 222,
              stderrTail: 'AssertionError\n',
              stdoutTail: 'SENTINEL_46\n',
            },
            proberAttempts: 1,
          },
        } as any,
      },
      ctxFor({ dossier })
    );
    expect((res as any).recipe_recorded).toBe(true);
    const recipe = dossier.latest()!.body.reproRecipe!;
    expect(recipe.candidateTestPath).toBe('tests/repro_46.py');
    expect(recipe.sentinelString).toBe('SENTINEL_46');
    expect(recipe.pipInstalls).toHaveLength(1);
    expect(recipe.pipInstalls[0].editable).toBe(true);
    expect(recipe.requiresCredentials).toEqual(['OPENAI_API_KEY']);
    expect(recipe.provenance.observedProbe?.sentinelObserved).toBe(true);
    expect(recipe.provenance.proberAttempts).toBe(1);
    // recordedAt was missing in the input; executor stamped it
    expect(recipe.provenance.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('drops a recipe missing required fields without failing the call', async () => {
    const dossier = new DossierStore();
    const res = await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'analyst-only call',
        confidence: 'medium',
        reproRecipe: {
          // Missing candidateTestPath / testSource / sentinelString -> dropped
          approach: 'incomplete sketch',
        } as any,
      },
      ctxFor({ dossier })
    );
    expect((res as any).snapshot_id).toBeTruthy();
    expect((res as any).recipe_recorded).toBe(false);
    expect(dossier.latest()!.body.reproRecipe).toBeUndefined();
  });

  it('clips an oversized testSource at the schema cap', async () => {
    const dossier = new DossierStore();
    const overflow = 'a'.repeat(8000);
    await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'prober oversize',
        confidence: 'medium',
        reproRecipe: {
          candidateTestPath: 'tests/repro.py',
          testSource: overflow,
          sentinelString: 'X',
          provenance: { recordedAt: '2025-01-01T00:00:00.000Z' },
        } as any,
      },
      ctxFor({ dossier })
    );
    expect(dossier.latest()!.body.reproRecipe!.testSource.length).toBe(4096);
  });

  it('omits the recipe entirely when none is supplied (Analyst path)', async () => {
    const dossier = new DossierStore();
    await recordEvidence.execute(
      {
        evidence: [],
        suspectSymbols: [],
        openQuestions: [],
        preconditions: [],
        summary: 'analyst, no recipe',
        confidence: 'medium',
      },
      ctxFor({ dossier })
    );
    expect(dossier.latest()!.body.reproRecipe).toBeUndefined();
  });
});

describe('write_investigation_notes — server-stamped recordedAt on findings', () => {
  it('accepts findings with no recordedAt and stamps an ISO timestamp', async () => {
    const notes = new InvestigationNotesStore();
    await writeInvestigationNotes.execute(
      {
        findings: [
          {
            id: 'f1',
            observation: 'symbol may be None',
            references: ['e1'],
          } as any,
        ],
        rootCauseHypothesis: 'rch',
        suggestedApproach: 'sa',
        risks: [],
        confidence: 'low',
      },
      ctxFor({ notes }, { dossierSnapshotId: 'snap-1' })
    );
    const all = notes.list();
    expect(all).toHaveLength(1);
    expect(all[0].body.findings[0].recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
