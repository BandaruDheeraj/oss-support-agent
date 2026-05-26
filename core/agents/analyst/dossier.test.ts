import { DossierStore, snapshotIdFor, DossierBodySchema, type DossierBody } from './dossier';

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
});
