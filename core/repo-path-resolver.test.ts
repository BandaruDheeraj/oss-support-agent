import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rankMatches, validateEditableInstallPath } from './repo-path-resolver';

describe('rankMatches', () => {
  it('prefers python/instrumentation/*/src/<suffix>', () => {
    const m = rankMatches([
      'fixtures/openinference/instrumentation/smolagents/_wrappers.py',
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py',
      'docs/copy/_wrappers.py',
    ]);
    expect(m[0]).toBe(
      'python/instrumentation/openinference-instrumentation-smolagents/src/openinference/instrumentation/smolagents/_wrappers.py'
    );
  });

  it('prefers /src/ over deep nested', () => {
    const m = rankMatches([
      'examples/foo/_wrappers.py',
      'libs/x/src/_wrappers.py',
    ]);
    expect(m[0]).toBe('libs/x/src/_wrappers.py');
  });

  it('breaks ties with shortest path', () => {
    const m = rankMatches([
      'a/very/deep/nested/dir/src/foo.py',
      'a/src/foo.py',
    ]);
    expect(m[0]).toBe('a/src/foo.py');
  });
});

describe('validateEditableInstallPath', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rpr-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null for dir with pyproject.toml', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'pyproject.toml'), '');
    expect(validateEditableInstallPath(tmp, 'pkg')).toBeNull();
  });

  it('returns null for dir with setup.py', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'));
    fs.writeFileSync(path.join(tmp, 'pkg', 'setup.py'), '');
    expect(validateEditableInstallPath(tmp, 'pkg')).toBeNull();
  });

  it('returns reason for missing dir', () => {
    expect(validateEditableInstallPath(tmp, 'nope')).toMatch(/does not exist/);
  });

  it('returns reason for dir without manifest', () => {
    fs.mkdirSync(path.join(tmp, 'pkg'));
    expect(validateEditableInstallPath(tmp, 'pkg')).toMatch(/no Python package manifest/);
  });

  it('returns reason when path is a file not a directory', () => {
    fs.writeFileSync(path.join(tmp, 'file'), '');
    expect(validateEditableInstallPath(tmp, 'file')).toMatch(/not a directory/);
  });
});
