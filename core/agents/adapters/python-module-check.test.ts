import { buildPythonImportCandidates, buildPythonModuleCheckSnippet } from './python-module-check';

describe('buildPythonImportCandidates', () => {
  it('passes through dotted import names unchanged', () => {
    expect(buildPythonImportCandidates('openinference.instrumentation.openai')).toEqual([
      'openinference.instrumentation.openai',
    ]);
  });

  it('normalizes hyphenated distribution names into import candidates', () => {
    expect(buildPythonImportCandidates('openinference-instrumentation-openai')).toEqual([
      'openinference-instrumentation-openai',
      'openinference_instrumentation_openai',
      'openinference.instrumentation.openai',
    ]);
  });

  it('derives basename candidates from repo-relative paths', () => {
    expect(
      buildPythonImportCandidates('python/instrumentation/openinference-instrumentation-smolagents')
    ).toEqual([
      'python/instrumentation/openinference-instrumentation-smolagents',
      'python/instrumentation/openinference_instrumentation_smolagents',
      'python/instrumentation/openinference.instrumentation.smolagents',
      'openinference-instrumentation-smolagents',
      'openinference_instrumentation_smolagents',
      'openinference.instrumentation.smolagents',
    ]);
  });

  it('returns an empty list for blank names', () => {
    expect(buildPythonImportCandidates('   ')).toEqual([]);
  });
});

describe('buildPythonModuleCheckSnippet', () => {
  it('emits a snippet that includes tried candidates and resolved module on success', () => {
    const snippet = buildPythonModuleCheckSnippet('openinference-instrumentation');
    expect(snippet).toContain('candidates = ["openinference-instrumentation","openinference_instrumentation","openinference.instrumentation"]');
    expect(snippet).toContain('"module": candidate');
    expect(snippet).toContain('"tried": candidates');
  });
});

