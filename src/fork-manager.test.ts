/**
 * Unit and integration tests for fork creation and branch management (US-006).
 */

import {
  ForkConfig,
  GitHubClient,
  ForkCreationError,
  BranchCreationError,
} from './fork-types';
import {
  generateBranchName,
  deriveForkName,
  createForkAndBranch,
} from './fork-manager';

/** Helper to create a mock GitHubClient */
function createMockClient(overrides: Partial<GitHubClient> = {}): GitHubClient {
  return {
    repoExists: jest.fn().mockResolvedValue(false),
    createFork: jest.fn().mockResolvedValue('my-org/openinference'),
    syncFork: jest.fn().mockResolvedValue(undefined),
    getDefaultBranch: jest.fn().mockResolvedValue('main'),
    getBranchSha: jest.fn().mockResolvedValue(null),
    createBranch: jest.fn().mockResolvedValue(undefined),
    updateBranchRef: jest.fn().mockResolvedValue(undefined),
    getTokenScopes: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function baseConfig(overrides: Partial<ForkConfig> = {}): ForkConfig {
  return {
    upstream: 'Arize-ai/openinference',
    forkOrg: 'my-org',
    branchPrefix: 'agent/scope-',
    issueIds: [142, 156, 203],
    ...overrides,
  };
}

describe('generateBranchName', () => {
  it('generates branch name with sorted issue IDs', () => {
    const config = baseConfig({ issueIds: [203, 142, 156] });
    expect(generateBranchName(config)).toBe('agent/scope-142-156-203');
  });

  it('handles single issue ID', () => {
    const config = baseConfig({ issueIds: [42] });
    expect(generateBranchName(config)).toBe('agent/scope-42');
  });

  it('uses custom branch prefix', () => {
    const config = baseConfig({ branchPrefix: 'fix/', issueIds: [1, 2] });
    expect(generateBranchName(config)).toBe('fix/1-2');
  });

  it('sorts numerically (not lexicographically)', () => {
    const config = baseConfig({ issueIds: [9, 100, 10, 2] });
    expect(generateBranchName(config)).toBe('agent/scope-2-9-10-100');
  });

  it('does not mutate original issueIds array', () => {
    const ids = [300, 100, 200];
    const config = baseConfig({ issueIds: ids });
    generateBranchName(config);
    expect(ids).toEqual([300, 100, 200]);
  });
});

describe('deriveForkName', () => {
  it('derives fork name from upstream and forkOrg', () => {
    expect(deriveForkName('Arize-ai/openinference', 'my-org')).toBe(
      'my-org/openinference'
    );
  });

  it('handles upstream with different owner', () => {
    expect(deriveForkName('facebook/react', 'agent-forks')).toBe(
      'agent-forks/react'
    );
  });

  it('throws on invalid upstream format', () => {
    expect(() => deriveForkName('invalid', 'my-org')).toThrow(
      ForkCreationError
    );
  });
});

describe('createForkAndBranch', () => {
  describe('fork creation', () => {
    it('creates a new fork when none exists', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockResolvedValue('my-org/openinference'),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123') // default branch SHA
          .mockResolvedValueOnce(null), // target branch doesn't exist
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(client.createFork).toHaveBeenCalledWith(
        'Arize-ai/openinference',
        'my-org'
      );
      expect(result.forkCreated).toBe(true);
      expect(result.forkFullName).toBe('my-org/openinference');
    });

    it('reuses existing fork without creating a new one', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123') // default branch SHA
          .mockResolvedValueOnce(null), // target branch doesn't exist
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(client.createFork).not.toHaveBeenCalled();
      expect(result.forkCreated).toBe(false);
    });

    it('syncs existing fork with upstream before branching', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce(null),
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(client.syncFork).toHaveBeenCalledWith('my-org/openinference');
      expect(result.forkSynced).toBe(true);
    });

    it('throws ForkCreationError when fork creation fails', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockRejectedValue(new Error('API error')),
      });

      await expect(createForkAndBranch(client, baseConfig())).rejects.toThrow(
        ForkCreationError
      );
    });

    it('throws ForkCreationError when sync fails on existing fork', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        syncFork: jest.fn().mockRejectedValue(new Error('Sync failed')),
      });

      await expect(createForkAndBranch(client, baseConfig())).rejects.toThrow(
        ForkCreationError
      );
    });

    it('tolerates sync failure on newly created fork', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockResolvedValue('my-org/openinference'),
        syncFork: jest.fn().mockRejectedValue(new Error('Sync failed')),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce(null),
      });

      const result = await createForkAndBranch(client, baseConfig());

      // Should not throw - new forks are already in sync
      expect(result.forkCreated).toBe(true);
      expect(result.forkSynced).toBe(false);
    });
  });

  describe('branch creation', () => {
    it('creates branch with deterministic name from sorted issue IDs', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123') // default branch SHA
          .mockResolvedValueOnce(null), // target branch doesn't exist
      });

      const result = await createForkAndBranch(
        client,
        baseConfig({ issueIds: [203, 142, 156] })
      );

      expect(result.branchName).toBe('agent/scope-142-156-203');
      expect(client.createBranch).toHaveBeenCalledWith(
        'my-org/openinference',
        'agent/scope-142-156-203',
        'abc123'
      );
      expect(result.branchReset).toBe(false);
    });

    it('resets branch to fork main if it already exists (retry)', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123') // default branch SHA
          .mockResolvedValueOnce('old-sha'), // target branch exists
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(client.updateBranchRef).toHaveBeenCalledWith(
        'my-org/openinference',
        'agent/scope-142-156-203',
        'abc123'
      );
      expect(client.createBranch).not.toHaveBeenCalled();
      expect(result.branchReset).toBe(true);
    });

    it('throws BranchCreationError when branch creation fails', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce(null),
        createBranch: jest.fn().mockRejectedValue(new Error('Branch error')),
      });

      await expect(createForkAndBranch(client, baseConfig())).rejects.toThrow(
        BranchCreationError
      );
    });

    it('throws BranchCreationError when branch reset fails', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce('old-sha'),
        updateBranchRef: jest
          .fn()
          .mockRejectedValue(new Error('Reset error')),
      });

      await expect(createForkAndBranch(client, baseConfig())).rejects.toThrow(
        BranchCreationError
      );
    });

    it('throws BranchCreationError when default branch SHA cannot be resolved', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest.fn().mockResolvedValue(null), // both calls return null
      });

      await expect(createForkAndBranch(client, baseConfig())).rejects.toThrow(
        BranchCreationError
      );
    });
  });

  describe('validation', () => {
    it('throws on invalid upstream format (no slash)', async () => {
      const client = createMockClient();
      const config = baseConfig({ upstream: 'invalid' });

      await expect(createForkAndBranch(client, config)).rejects.toThrow(
        ForkCreationError
      );
    });

    it('throws on empty forkOrg', async () => {
      const client = createMockClient();
      const config = baseConfig({ forkOrg: '' });

      await expect(createForkAndBranch(client, config)).rejects.toThrow(
        ForkCreationError
      );
    });

    it('throws on empty issueIds', async () => {
      const client = createMockClient();
      const config = baseConfig({ issueIds: [] });

      await expect(createForkAndBranch(client, config)).rejects.toThrow(
        ForkCreationError
      );
    });
  });

  describe('upstream write guard', () => {
    it('calls getTokenScopes to verify access', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce(null),
      });

      await createForkAndBranch(client, baseConfig());

      expect(client.getTokenScopes).toHaveBeenCalled();
    });

    it('all writes go to fork only (never upstream)', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockResolvedValue('my-org/openinference'),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('abc123')
          .mockResolvedValueOnce(null),
      });

      await createForkAndBranch(client, baseConfig());

      // Verify createBranch was called with fork name, not upstream
      expect(client.createBranch).toHaveBeenCalledWith(
        'my-org/openinference', // fork, not 'Arize-ai/openinference'
        expect.any(String),
        expect.any(String)
      );
      // syncFork called with fork name
      expect(client.syncFork).toHaveBeenCalledWith('my-org/openinference');
    });
  });

  describe('integration: full flow', () => {
    it('creates fork, syncs, and branches in one call (new fork)', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockResolvedValue('my-org/openinference'),
        syncFork: jest.fn().mockRejectedValue(new Error('new fork')),
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('def456') // default branch SHA
          .mockResolvedValueOnce(null), // target branch doesn't exist
        getTokenScopes: jest.fn().mockResolvedValue([]),
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(result).toEqual({
        forkFullName: 'my-org/openinference',
        forkCreated: true,
        forkSynced: false,
        branchName: 'agent/scope-142-156-203',
        branchReset: false,
      });
    });

    it('reuses fork, syncs, and resets branch (retry scenario)', async () => {
      const client = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        syncFork: jest.fn().mockResolvedValue(undefined),
        getDefaultBranch: jest.fn().mockResolvedValue('main'),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('new-main-sha') // default branch SHA
          .mockResolvedValueOnce('old-branch-sha'), // target branch exists
        getTokenScopes: jest.fn().mockResolvedValue([]),
      });

      const result = await createForkAndBranch(client, baseConfig());

      expect(result).toEqual({
        forkFullName: 'my-org/openinference',
        forkCreated: false,
        forkSynced: true,
        branchName: 'agent/scope-142-156-203',
        branchReset: true,
      });
      expect(client.updateBranchRef).toHaveBeenCalledWith(
        'my-org/openinference',
        'agent/scope-142-156-203',
        'new-main-sha'
      );
    });

    it('second run on same issue group reuses fork and resets branch', async () => {
      // First run
      const firstClient = createMockClient({
        repoExists: jest.fn().mockResolvedValue(false),
        createFork: jest.fn().mockResolvedValue('my-org/openinference'),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('sha1')
          .mockResolvedValueOnce(null),
      });
      const firstResult = await createForkAndBranch(firstClient, baseConfig());
      expect(firstResult.forkCreated).toBe(true);
      expect(firstResult.branchReset).toBe(false);

      // Second run - fork exists, branch exists
      const secondClient = createMockClient({
        repoExists: jest.fn().mockResolvedValue(true),
        getBranchSha: jest
          .fn()
          .mockResolvedValueOnce('sha2') // updated main
          .mockResolvedValueOnce('sha1'), // old branch still there
      });
      const secondResult = await createForkAndBranch(secondClient, baseConfig());
      expect(secondResult.forkCreated).toBe(false);
      expect(secondResult.branchReset).toBe(true);
      expect(secondClient.updateBranchRef).toHaveBeenCalledWith(
        'my-org/openinference',
        'agent/scope-142-156-203',
        'sha2'
      );
    });
  });

  describe('one fork per issue group', () => {
    it('same issue group always produces same branch name', () => {
      const config1 = baseConfig({ issueIds: [156, 142, 203] });
      const config2 = baseConfig({ issueIds: [203, 156, 142] });
      const config3 = baseConfig({ issueIds: [142, 156, 203] });

      expect(generateBranchName(config1)).toBe('agent/scope-142-156-203');
      expect(generateBranchName(config2)).toBe('agent/scope-142-156-203');
      expect(generateBranchName(config3)).toBe('agent/scope-142-156-203');
    });

    it('different issue groups produce different branch names', () => {
      const config1 = baseConfig({ issueIds: [1, 2] });
      const config2 = baseConfig({ issueIds: [1, 3] });

      expect(generateBranchName(config1)).not.toBe(generateBranchName(config2));
    });
  });
});
