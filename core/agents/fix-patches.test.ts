/**
 * Tests for the search/replace patch application path used by the fix agent.
 */
import { applyPatch, applyPatches } from './fix-patches';
import type { RepoFileReader, FilePatch } from './fix-types';

function makeReader(files: Record<string, string>): RepoFileReader {
  return {
    readFile: jest.fn(async (_fork, _branch, path) => {
      if (!(path in files)) throw new Error(`ENOENT ${path}`);
      return files[path];
    }),
    listFiles: jest.fn().mockResolvedValue([]),
  };
}

describe('applyPatch', () => {
  const ctx = (files: Record<string, string>) => ({
    forkFullName: 'org/repo',
    branch: 'agent/fix-1',
    reader: makeReader(files),
  });

  it('applies a unique-match patch and returns full post-edit content', async () => {
    const original =
      'def foo(x):\n    if x is None:\n        return 0\n    return x + 1\n';
    const patch: FilePatch = {
      path: 'src/foo.py',
      oldText: '    if x is None:\n        return 0\n',
      newText: '    if x is None:\n        return 0\n    if not isinstance(x, int):\n        return -1\n',
    };
    const change = await applyPatch(patch, ctx({ 'src/foo.py': original }));
    expect(change.action).toBe('modify');
    expect(change.path).toBe('src/foo.py');
    expect(change.content).toContain('isinstance(x, int)');
    expect(change.content).toContain('return x + 1');
    expect(change.content).not.toBe(original);
  });

  it('rejects patch when oldText does not match', async () => {
    const original = 'line one\nline two\nline three\n';
    const patch: FilePatch = {
      path: 'a.py',
      oldText: 'line zero\n',
      newText: 'line zero (new)\n',
    };
    await expect(applyPatch(patch, ctx({ 'a.py': original }))).rejects.toMatchObject({
      name: 'FixAgentError',
      phase: 'patch_not_found',
    });
  });

  it('rejects patch when oldText matches more than once', async () => {
    const original = 'pass\npass\n';
    const patch: FilePatch = {
      path: 'a.py',
      oldText: 'pass\n',
      newText: 'return\n',
    };
    await expect(applyPatch(patch, ctx({ 'a.py': original }))).rejects.toMatchObject({
      name: 'FixAgentError',
      phase: 'patch_ambiguous',
    });
  });

  it('rejects patch when target file does not exist on the branch', async () => {
    const patch: FilePatch = {
      path: 'missing.py',
      oldText: 'x',
      newText: 'y',
    };
    await expect(applyPatch(patch, ctx({}))).rejects.toMatchObject({
      name: 'FixAgentError',
      phase: 'patch_target_missing',
    });
  });

  it('rejects patch with empty oldText', async () => {
    const patch: FilePatch = { path: 'a.py', oldText: '', newText: 'x' };
    await expect(applyPatch(patch, ctx({ 'a.py': 'content' }))).rejects.toMatchObject({
      phase: 'patch_invalid',
    });
  });

  it('rejects patch where newText equals oldText (no-op)', async () => {
    const patch: FilePatch = {
      path: 'a.py',
      oldText: 'unique line\n',
      newText: 'unique line\n',
    };
    await expect(applyPatch(patch, ctx({ 'a.py': 'unique line\n' }))).rejects.toMatchObject({
      phase: 'patch_noop',
    });
  });

  it('handles multi-line replacement with surrounding context preserved', async () => {
    const original = 'header\nbody\nfooter\n';
    const patch: FilePatch = {
      path: 'a.py',
      oldText: 'header\nbody\n',
      newText: 'header\nguard\nbody\n',
    };
    const change = await applyPatch(patch, ctx({ 'a.py': original }));
    expect(change.content).toBe('header\nguard\nbody\nfooter\n');
  });
});

describe('applyPatches', () => {
  const makeCtx = (files: Record<string, string>) => ({
    forkFullName: 'org/repo',
    branch: 'agent/fix-1',
    reader: makeReader(files),
  });

  it('applies patches across multiple files independently', async () => {
    const files = {
      'a.py': 'foo\n',
      'b.py': 'bar\n',
    };
    const patches: FilePatch[] = [
      { path: 'a.py', oldText: 'foo\n', newText: 'foo!\n' },
      { path: 'b.py', oldText: 'bar\n', newText: 'bar!\n' },
    ];
    const out = await applyPatches(patches, makeCtx(files));
    expect(out).toHaveLength(2);
    const byPath = Object.fromEntries(out.map((c) => [c.path, c.content]));
    expect(byPath['a.py']).toBe('foo!\n');
    expect(byPath['b.py']).toBe('bar!\n');
  });

  it('chains multiple patches on the same file (later patches see earlier edits)', async () => {
    const original = 'one\ntwo\nthree\n';
    const patches: FilePatch[] = [
      { path: 'a.py', oldText: 'one\n', newText: 'ONE\n' },
      // After first patch the file is "ONE\ntwo\nthree\n" — second patch must
      // match the post-first-patch content, not the original.
      { path: 'a.py', oldText: 'three\n', newText: 'THREE\n' },
    ];
    const out = await applyPatches(patches, makeCtx({ 'a.py': original }));
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('ONE\ntwo\nTHREE\n');
  });

  it('reads each fresh path only once from the reader', async () => {
    const reader = makeReader({ 'a.py': 'x\n' });
    const patches: FilePatch[] = [
      { path: 'a.py', oldText: 'x\n', newText: 'y\n' },
    ];
    await applyPatches(patches, {
      forkFullName: 'o/r',
      branch: 'b',
      reader,
    });
    expect(reader.readFile).toHaveBeenCalledTimes(1);
  });

  it('surfaces patch_not_found from sequential application', async () => {
    const patches: FilePatch[] = [
      { path: 'a.py', oldText: 'one\n', newText: 'ONE\n' },
      { path: 'a.py', oldText: 'NOPE\n', newText: 'X\n' },
    ];
    await expect(
      applyPatches(patches, makeCtx({ 'a.py': 'one\n' }))
    ).rejects.toMatchObject({ phase: 'patch_not_found' });
  });
});
