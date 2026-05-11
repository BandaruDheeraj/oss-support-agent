import {
  validateReproSetup,
  buildPipInstallCommands,
  ReproSetupValidationError,
} from './repro-setup-validation';

describe('validateReproSetup', () => {
  it('accepts empty input', () => {
    expect(validateReproSetup({})).toEqual({ editableInstalls: [], pipPackages: [] });
  });

  it('accepts safe pipPackages', () => {
    const r = validateReproSetup({
      pipPackages: ['pytest', 'requests>=2.0', 'openai==1.30.1', 'pydantic[email]', 'numpy~=1.26'],
    });
    expect(r.pipPackages).toHaveLength(5);
  });

  it('accepts safe editableInstalls', () => {
    const r = validateReproSetup({
      editableInstalls: [
        'python/instrumentation/openinference-instrumentation-smolagents',
        'packages/foo',
      ],
    });
    expect(r.editableInstalls).toHaveLength(2);
  });

  it.each([
    ['-r requirements.txt'],
    ['--index-url=http://evil/'],
    ['git+https://github.com/x/y'],
    ['./local'],
    ['foo bar'],
    ['foo;rm -rf /'],
    ['foo && echo'],
    ['foo|tee'],
    ['$(whoami)'],
    ['`whoami`'],
    ["foo; python_version<'3.8'"],
    ['http://pypi/foo'],
  ])('rejects pipPackages entry %s', (bad) => {
    expect(() => validateReproSetup({ pipPackages: [bad] })).toThrow(ReproSetupValidationError);
  });

  it.each([
    ['/abs/path'],
    ['C:/win/path'],
    ['../escape'],
    ['python/../etc/passwd'],
    ['has space'],
    ['has;semi'],
    ['has$dollar'],
    ['has`backtick`'],
    ['has\\backslash'],
  ])('rejects editableInstalls entry %s', (bad) => {
    expect(() => validateReproSetup({ editableInstalls: [bad] })).toThrow(ReproSetupValidationError);
  });

  it('caps editableInstalls count', () => {
    expect(() =>
      validateReproSetup({ editableInstalls: Array(10).fill('packages/foo') })
    ).toThrow(/max 5/);
  });

  it('caps pipPackages count', () => {
    expect(() =>
      validateReproSetup({ pipPackages: Array(40).fill('pytest') })
    ).toThrow(/max 30/);
  });

  it('rejects extremely long entries', () => {
    const long = 'a'.repeat(300);
    expect(() => validateReproSetup({ pipPackages: [long] })).toThrow(/too long/);
  });
});

describe('buildPipInstallCommands', () => {
  it('emits one batched pip install for pipPackages', () => {
    expect(
      buildPipInstallCommands({ pipPackages: ['pytest', 'requests'], editableInstalls: [] })
    ).toEqual(['pip install --quiet pytest requests']);
  });

  it('emits one pip install -e per editable', () => {
    expect(
      buildPipInstallCommands({
        pipPackages: [],
        editableInstalls: ['python/foo', 'python/bar'],
      })
    ).toEqual([
      'pip install --quiet -e python/foo',
      'pip install --quiet -e python/bar',
    ]);
  });

  it('returns empty list for empty input', () => {
    expect(buildPipInstallCommands({ pipPackages: [], editableInstalls: [] })).toEqual([]);
  });
});
