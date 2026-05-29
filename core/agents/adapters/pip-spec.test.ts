import { pipSpecToImportProbeName, resolveSkippablePipInstall } from './pip-spec';

describe('pipSpecToImportProbeName', () => {
  it('accepts bare import-like module specs', () => {
    expect(pipSpecToImportProbeName('inspect')).toBe('inspect');
    expect(pipSpecToImportProbeName('json')).toBe('json');
    expect(pipSpecToImportProbeName('foo.bar')).toBe('foo.bar');
  });

  it('rejects non-import-like pip specs', () => {
    expect(pipSpecToImportProbeName('-e python/instrumentation/foo')).toBeNull();
    expect(pipSpecToImportProbeName('requests>=2.31.0')).toBeNull();
    expect(pipSpecToImportProbeName('google-genai')).toBeNull();
    expect(pipSpecToImportProbeName('foo[dev]')).toBeNull();
    expect(pipSpecToImportProbeName('a b')).toBeNull();
  });
});

describe('resolveSkippablePipInstall', () => {
  it('skips when module is already importable', async () => {
    const moduleCheck = jest.fn(async () => ({ importable: true }));
    await expect(resolveSkippablePipInstall('inspect', moduleCheck)).resolves.toBe('inspect');
    expect(moduleCheck).toHaveBeenCalledWith('inspect');
  });

  it('does not skip when module is not importable', async () => {
    const moduleCheck = jest.fn(async () => ({ importable: false }));
    await expect(resolveSkippablePipInstall('pytest', moduleCheck)).resolves.toBeNull();
    expect(moduleCheck).toHaveBeenCalledWith('pytest');
  });

  it('does not call module check for non-probeable specs', async () => {
    const moduleCheck = jest.fn(async () => ({ importable: true }));
    await expect(resolveSkippablePipInstall('-e python/foo', moduleCheck)).resolves.toBeNull();
    expect(moduleCheck).not.toHaveBeenCalled();
  });
});

