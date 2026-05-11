import {
  detectCredentialError,
  findMissingDeclaredCredentials,
  mergeCredentialSources,
} from './credentials-check';
import type { RequiredCredential } from './agents/repro-types';

describe('findMissingDeclaredCredentials', () => {
  it('returns empty when nothing declared', () => {
    expect(findMissingDeclaredCredentials(undefined, {}).missing).toEqual([]);
    expect(findMissingDeclaredCredentials([], {}).missing).toEqual([]);
  });

  it('flags env vars that are unset', () => {
    const required: RequiredCredential[] = [
      { envVar: 'OPENAI_API_KEY', purpose: 'OpenAI client' },
      { envVar: 'PRESENT_KEY', purpose: 'something' },
    ];
    const { missing } = findMissingDeclaredCredentials(required, {
      PRESENT_KEY: 'value',
    } as any);
    expect(missing.map((c) => c.envVar)).toEqual(['OPENAI_API_KEY']);
  });

  it('treats empty string as missing', () => {
    const required: RequiredCredential[] = [
      { envVar: 'EMPTY_KEY', purpose: 'x' },
    ];
    const { missing } = findMissingDeclaredCredentials(required, {
      EMPTY_KEY: '   ',
    } as any);
    expect(missing.map((c) => c.envVar)).toEqual(['EMPTY_KEY']);
  });
});

describe('detectCredentialError', () => {
  it('returns false for benign output', () => {
    const r = detectCredentialError('hello', 'AssertionError: spans not closed');
    expect(r.isCredentialError).toBe(false);
    expect(r.inferredEnvVars).toEqual([]);
  });

  it('detects AuthenticationError and extracts env tokens', () => {
    const stderr = `Traceback (most recent call last):
  ...
openai.AuthenticationError: The api_key client option must be set either by passing api_key to the client or by setting the OPENAI_API_KEY environment variable`;
    const r = detectCredentialError('', stderr);
    expect(r.isCredentialError).toBe(true);
    expect(r.inferredEnvVars).toContain('OPENAI_API_KEY');
  });

  it('detects "is not set" style messages', () => {
    const r = detectCredentialError(
      '',
      'RuntimeError: ANTHROPIC_API_KEY is not set, please configure it.'
    );
    expect(r.isCredentialError).toBe(true);
    expect(r.inferredEnvVars).toContain('ANTHROPIC_API_KEY');
  });

  it('detects HTTP 401 unauthorized', () => {
    const r = detectCredentialError('', 'urllib.error.HTTPError: HTTP Error 401: Unauthorized');
    expect(r.isCredentialError).toBe(true);
    expect(r.matchedPattern).toBe('http-401');
  });

  it('does not flag generic ALL_CAPS tokens like exception names', () => {
    const r = detectCredentialError(
      '',
      'AuthenticationError: bad creds (saw MODULE_NOT_FOUND_ERROR earlier, ignored)'
    );
    expect(r.isCredentialError).toBe(true);
    // MODULE_NOT_FOUND_ERROR is in the blocklist
    expect(r.inferredEnvVars).not.toContain('MODULE_NOT_FOUND_ERROR');
  });
});

describe('mergeCredentialSources', () => {
  it('keeps declared entries over inferred name-only ones', () => {
    const declared: RequiredCredential[] = [
      { envVar: 'OPENAI_API_KEY', purpose: 'OpenAI client', whereToGet: 'https://platform.openai.com/api-keys' },
    ];
    const merged = mergeCredentialSources(declared, ['OPENAI_API_KEY', 'OTHER_KEY']);
    const openai = merged.find((c) => c.envVar === 'OPENAI_API_KEY');
    expect(openai?.purpose).toBe('OpenAI client');
    expect(openai?.whereToGet).toBe('https://platform.openai.com/api-keys');
    const other = merged.find((c) => c.envVar === 'OTHER_KEY');
    expect(other?.purpose).toMatch(/inferred/);
  });

  it('dedupes inferred names', () => {
    const merged = mergeCredentialSources([], ['X_KEY', 'X_KEY', 'Y_KEY']);
    expect(merged.map((c) => c.envVar).sort()).toEqual(['X_KEY', 'Y_KEY']);
  });
});
