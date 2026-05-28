import { DossierStore, snapshotIdFor, DossierBodySchema, normalizeReproTargetsInput, type DossierBody } from './dossier';

function makeBody(overrides: Partial<DossierBody> = {}): DossierBody {
  return DossierBodySchema.parse({
    issueNumber: 46,
    attemptId: 'attempt-1',
    parentSnapshotId: null,
    evidence: [
      {
        id: 'ev-1',
        kind: 'file_excerpt',
        source: 'src/foo.py',
        summary: 'first',
        recordedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    suspectSymbols: [{ file: 'src/foo.py', symbol: 'finalize', reasoning: 'crashes here' }],
    openQuestions: [],
    summary: 'first dossier',
    confidence: 'medium',
    ...overrides,
  });
}

describe('dossier snapshot id', () => {
  it('is stable for bodies without preconditions', () => {
    const body = makeBody();
    expect(snapshotIdFor(body)).toBe(snapshotIdFor(body));
  });

  it('omits empty preconditions from the canonical hash (backward compat)', () => {
    // A legacy snapshot persisted before the preconditions field existed.
    // After normalization through DossierBodySchema, `preconditions` is
    // defaulted to []. The snapshot id MUST equal the hash of the body
    // computed without the preconditions key — otherwise investigation
    // notes bound to the legacy id break their link.
    const legacyBody = {
      issueNumber: 46,
      attemptId: 'attempt-1',
      parentSnapshotId: null,
      evidence: [
        {
          id: 'ev-1',
          kind: 'file_excerpt' as const,
          source: 'src/foo.py',
          summary: 'first',
          recordedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      suspectSymbols: [{ file: 'src/foo.py', symbol: 'finalize', reasoning: 'crashes here' }],
      openQuestions: [],
      summary: 'first dossier',
      confidence: 'medium' as const,
    };
    const normalized = DossierBodySchema.parse(legacyBody);
    expect(normalized.preconditions).toEqual([]);

    // The id computed on the normalized body (with empty preconditions)
    // must equal the id computed on a body literally lacking the field.
    const idFromNormalized = snapshotIdFor(normalized);
    const idFromLegacyShape = snapshotIdFor(legacyBody as unknown as DossierBody);
    expect(idFromNormalized).toBe(idFromLegacyShape);
  });

  it('changes when preconditions are non-empty', () => {
    const without = makeBody();
    const withPc = makeBody({
      preconditions: [
        {
          id: 'pc-0',
          condition: 'no tracer provider configured',
          kind: 'config_absence',
          evidenceRefs: [],
          satisfactionModes: [],
          threats: [],
        },
      ],
    });
    expect(snapshotIdFor(without)).not.toBe(snapshotIdFor(withPc));
  });

  it('omits absent reproRecipe from the canonical hash (backward compat)', () => {
    // Body literally lacking the reproRecipe key (pre-Prober pipeline)
    const legacy = makeBody();
    // Body where reproRecipe is explicitly undefined (post-Prober pipeline
    // before Prober runs) — should hash identically
    const explicitUndef = { ...makeBody(), reproRecipe: undefined } as DossierBody;
    expect(snapshotIdFor(explicitUndef)).toBe(snapshotIdFor(legacy));
  });

  it('changes when reproRecipe is present', () => {
    const without = makeBody();
    const recipe: NonNullable<DossierBody['reproRecipe']> = {
      version: 1,
      candidateTestPath: 'tests/repro_46.py',
      testSource: 'def test_x():\n    assert False  # SENTINEL_46\n',
      sentinelString: 'SENTINEL_46',
      pipInstalls: [],
      requiresCredentials: [],
      verbatimSnippetIncompatible: false,
      approach: '',
      provenance: {
        exerciseImports: [],
        preconditionsSatisfied: [],
        observedProbe: null,
        proberAttempts: 0,
        recordedAt: '2025-01-01T00:00:00.000Z',
      },
    };
    const withRecipe = makeBody({ reproRecipe: recipe });
    expect(snapshotIdFor(without)).not.toBe(snapshotIdFor(withRecipe));
  });

  it('omits absent candidateRepro from the canonical hash (backward compat)', () => {
    const legacy = makeBody();
    const explicitUndef = { ...makeBody(), candidateRepro: undefined } as DossierBody;
    expect(snapshotIdFor(explicitUndef)).toBe(snapshotIdFor(legacy));
  });

  it('omits absent reproTargets from the canonical hash (backward compat)', () => {
    const legacy = makeBody();
    const explicitUndef = { ...makeBody(), reproTargets: undefined } as DossierBody;
    expect(snapshotIdFor(explicitUndef)).toBe(snapshotIdFor(legacy));
  });

  it('omits all-empty reproTargets from the canonical hash (back-compat with schema defaults)', () => {
    // A body where the field is present but both arrays are empty MUST
    // hash identically to a body literally lacking the field — otherwise
    // schema-defaulted snapshots break links bound to legacy ids.
    const legacy = makeBody();
    const withEmpty = makeBody({ reproTargets: { editableInstall: [], runtimeForbidden: [] } });
    expect(snapshotIdFor(withEmpty)).toBe(snapshotIdFor(legacy));
  });

  it('changes when reproTargets has non-empty editableInstall', () => {
    const without = makeBody();
    const withTargets = makeBody({
      reproTargets: { editableInstall: ['python/pkg-a'], runtimeForbidden: [] },
    });
    expect(snapshotIdFor(without)).not.toBe(snapshotIdFor(withTargets));
  });

  it('changes when reproTargets has non-empty runtimeForbidden', () => {
    const without = makeBody();
    const withTargets = makeBody({
      reproTargets: { editableInstall: [], runtimeForbidden: ['smolagents'] },
    });
    expect(snapshotIdFor(without)).not.toBe(snapshotIdFor(withTargets));
  });

  it('changes when candidateRepro is present', () => {
    const without = makeBody();
    const withCand = makeBody({
      candidateRepro: {
        version: 1,
        source: 'direct_call',
        failureMode: 'unexpected_exception',
        candidateTestPath: 'tests/test_repro_46.py',
        imports: ['from x import y'],
        setup: 'y = 1',
        exerciseCall: 'y.crash()',
        sentinel: 'SENTINEL_CR_46',
        pipInstalls: [],
        requiresCredentials: [],
        preconditionsSatisfied: [],
        rationale: '',
      },
    });
    expect(snapshotIdFor(without)).not.toBe(snapshotIdFor(withCand));
  });
});

describe('DossierStore.deserialize backward compat', () => {
  it('preserves legacy snapshot ids when rehydrating', () => {
    // Simulate a snapshot persisted before the preconditions feature: the
    // body lacks the preconditions key entirely, and the stored snapshotId
    // was computed from that legacy body.
    const legacyBody = {
      issueNumber: 46,
      attemptId: 'attempt-1',
      parentSnapshotId: null,
      evidence: [
        {
          id: 'ev-1',
          kind: 'file_excerpt' as const,
          source: 'src/foo.py',
          summary: 'first',
          recordedAt: '2025-01-01T00:00:00.000Z',
        },
      ],
      suspectSymbols: [{ file: 'src/foo.py', symbol: 'finalize', reasoning: 'why' }],
      openQuestions: [],
      summary: 'first',
      confidence: 'medium' as const,
    };
    const legacyId = snapshotIdFor(legacyBody as unknown as DossierBody);
    const persisted = JSON.stringify([
      { snapshotId: legacyId, createdAt: '2025-01-01T00:00:00.000Z', body: legacyBody },
    ]);

    const store = DossierStore.deserialize(persisted);
    const snap = store.latest();
    expect(snap).not.toBeNull();
    // Critical invariant: id survives the schema normalization
    expect(snap!.snapshotId).toBe(legacyId);
    // Runtime body now has the default-filled preconditions field
    expect(snap!.body.preconditions).toEqual([]);
  });

  it('round-trips bodies with non-empty preconditions', () => {
    const store = new DossierStore();
    const snap = store.append({
      issueNumber: 46,
      attemptId: 'attempt-1',
      evidence: [],
      suspectSymbols: [],
      openQuestions: [],
      summary: 's',
      confidence: 'low',
      preconditions: [
        {
          id: 'pc-0',
          condition: 'no tracer provider configured',
          kind: 'config_absence',
          evidenceRefs: ['ev-1'],
          satisfactionModes: [
            { description: 'direct NonRecordingSpan', markers: ['NonRecordingSpan('] },
          ],
          threats: ['conftest.py installs TracerProvider via autouse'],
        },
      ],
    });

    const rehydrated = DossierStore.deserialize(store.serialize());
    expect(rehydrated.latest()!.snapshotId).toBe(snap.snapshotId);
    expect(rehydrated.latest()!.body.preconditions).toHaveLength(1);
    expect(rehydrated.latest()!.body.preconditions[0].kind).toBe('config_absence');
  });

  it('round-trips a reproRecipe with observedProbe', () => {
    const store = new DossierStore();
    const snap = store.append({
      issueNumber: 46,
      attemptId: 'attempt-1',
      evidence: [],
      suspectSymbols: [],
      openQuestions: [],
      summary: 's',
      confidence: 'high',
      reproRecipe: {
        version: 1,
        candidateTestPath: 'tests/repro_46.py',
        testSource:
          'from opentelemetry import trace\nfrom openinference.instrumentation.smolagents import SmolagentsInstrumentor\n\ndef test_repro():\n    SmolagentsInstrumentor().instrument()\n    span = trace.get_current_span()\n    assert hasattr(span, "set_attribute")  # SENTINEL_46\n',
        sentinelString: 'SENTINEL_46',
        expectedFailureSignature: "AttributeError: 'NonRecordingSpan'",
        pipInstalls: [
          { package: 'openinference-instrumentation-smolagents', editable: true },
        ],
        requiresCredentials: [],
        verbatimSnippetIncompatible: true,
        approach: 'Trigger NonRecordingSpan in instrumented smolagents path.',
        provenance: {
          exerciseImports: ['openinference.instrumentation.smolagents'],
          preconditionsSatisfied: ['pc-0'],
          observedProbe: {
            sentinelObserved: true,
            signatureObserved: true,
            exitCode: 1,
            durationMs: 432,
            stderrTail: "AttributeError: 'NonRecordingSpan' object has no attribute 'set_attribute'\n",
            stdoutTail: 'SENTINEL_46\n',
          },
          proberAttempts: 2,
          recordedAt: '2025-01-01T00:00:00.000Z',
        },
      },
    });

    const rehydrated = DossierStore.deserialize(store.serialize());
    expect(rehydrated.latest()!.snapshotId).toBe(snap.snapshotId);
    const recipe = rehydrated.latest()!.body.reproRecipe!;
    expect(recipe.candidateTestPath).toBe('tests/repro_46.py');
    expect(recipe.provenance.observedProbe?.sentinelObserved).toBe(true);
    expect(recipe.provenance.observedProbe?.signatureObserved).toBe(true);
    expect(recipe.pipInstalls[0]).toEqual({
      package: 'openinference-instrumentation-smolagents',
      editable: true,
    });
  });

  it('legacy snapshots (no reproRecipe key) keep their id after deserialize', () => {
    // Pre-Prober body: lacks both preconditions AND reproRecipe entirely.
    const legacyBody = {
      issueNumber: 46,
      attemptId: 'attempt-1',
      parentSnapshotId: null,
      evidence: [],
      suspectSymbols: [],
      openQuestions: [],
      summary: 's',
      confidence: 'medium' as const,
    };
    const legacyId = snapshotIdFor(legacyBody as unknown as DossierBody);
    const persisted = JSON.stringify([
      { snapshotId: legacyId, createdAt: '2025-01-01T00:00:00.000Z', body: legacyBody },
    ]);
    const store = DossierStore.deserialize(persisted);
    expect(store.latest()!.snapshotId).toBe(legacyId);
    expect(store.latest()!.body.reproRecipe).toBeUndefined();
  });

  it('round-trips a body with reproTargets', () => {
    const store = new DossierStore();
    const snap = store.append({
      issueNumber: 46,
      attemptId: 'attempt-1',
      evidence: [],
      suspectSymbols: [],
      openQuestions: [],
      summary: 's',
      confidence: 'medium',
      reproTargets: {
        editableInstall: ['python/pkg-a', 'python/pkg-b'],
        runtimeForbidden: ['smolagents'],
      },
    });
    const rehydrated = DossierStore.deserialize(store.serialize());
    expect(rehydrated.latest()!.snapshotId).toBe(snap.snapshotId);
    expect(rehydrated.latest()!.body.reproTargets).toEqual({
      editableInstall: ['python/pkg-a', 'python/pkg-b'],
      runtimeForbidden: ['smolagents'],
    });
  });
});

describe('normalizeReproTargetsInput', () => {
  it('returns null for nullish / non-object input', () => {
    expect(normalizeReproTargetsInput(null)).toBeNull();
    expect(normalizeReproTargetsInput(undefined)).toBeNull();
    expect(normalizeReproTargetsInput('nope')).toBeNull();
  });

  it('returns null when both arrays are empty after cleaning', () => {
    expect(normalizeReproTargetsInput({ editableInstall: [], runtimeForbidden: [] })).toBeNull();
    // Non-string entries get dropped — same as empty.
    expect(
      normalizeReproTargetsInput({ editableInstall: [1, null, {}], runtimeForbidden: [true] })
    ).toBeNull();
  });

  it('strips leading/trailing slashes + backslashes and de-dupes editableInstall', () => {
    const r = normalizeReproTargetsInput({
      editableInstall: ['/python/pkg/', 'python\\pkg', 'python/other', 'python/other'],
    });
    expect(r).toEqual({
      editableInstall: ['python/pkg', 'python/other'],
      runtimeForbidden: [],
    });
  });

  it('lowercases + de-dupes runtimeForbidden', () => {
    const r = normalizeReproTargetsInput({
      runtimeForbidden: ['Smolagents', 'smolagents', 'LangChain'],
    });
    expect(r).toEqual({
      editableInstall: [],
      runtimeForbidden: ['smolagents', 'langchain'],
    });
  });

  it('ignores unknown keys via passthrough', () => {
    const r = normalizeReproTargetsInput({
      editableInstall: ['a'],
      runtimeForbidden: ['b'],
      bogus: 'ignored',
    });
    expect(r).toEqual({ editableInstall: ['a'], runtimeForbidden: ['b'] });
  });
});
