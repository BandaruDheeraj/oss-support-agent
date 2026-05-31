import type { SandboxHandle } from '../tools/handles';
import { createSandboxAdapter, selectSandboxDriver } from './index';
import { createLocalSandboxAdapter } from './sandbox-local';
import { createGhActionsSandboxAdapter } from './sandbox-gh-actions';

jest.mock('./sandbox-local', () => ({
  createLocalSandboxAdapter: jest.fn(),
}));

jest.mock('./sandbox-gh-actions', () => ({
  createGhActionsSandboxAdapter: jest.fn(),
}));

const createLocalSandboxAdapterMock =
  createLocalSandboxAdapter as jest.MockedFunction<typeof createLocalSandboxAdapter>;
const createGhActionsSandboxAdapterMock =
  createGhActionsSandboxAdapter as jest.MockedFunction<typeof createGhActionsSandboxAdapter>;

describe('sandbox adapter driver resolution', () => {
  const localHandle = { kind: 'local' } as unknown as SandboxHandle;
  const ghaHandle = { kind: 'gha' } as unknown as SandboxHandle;
  const workspace = { cwd: '/tmp/workspace', push: jest.fn().mockResolvedValue(undefined) } as any;
  const ghActionsOptions = {
    actionsClient: {} as any,
    baseConfig: {
      repoFullName: 'owner/repo',
      forkFullName: 'owner/repo',
      branchName: 'repro-branch',
      workflowRepoFullName: 'owner/repo',
      sandboxServices: [] as string[],
      timeoutMinutes: 15,
    },
  };
  const priorDriver = process.env.OSA_SANDBOX_DRIVER;

  beforeEach(() => {
    createLocalSandboxAdapterMock.mockReset();
    createGhActionsSandboxAdapterMock.mockReset();
    createLocalSandboxAdapterMock.mockReturnValue(localHandle);
    createGhActionsSandboxAdapterMock.mockReturnValue(ghaHandle);
    workspace.push.mockReset();
    workspace.push.mockResolvedValue(undefined);
    if (priorDriver === undefined) {
      delete process.env.OSA_SANDBOX_DRIVER;
    } else {
      process.env.OSA_SANDBOX_DRIVER = priorDriver;
    }
  });

  afterAll(() => {
    if (priorDriver === undefined) {
      delete process.env.OSA_SANDBOX_DRIVER;
    } else {
      process.env.OSA_SANDBOX_DRIVER = priorDriver;
    }
  });

  it('normalizes manifest-style gha alias to gh-actions', () => {
    expect(selectSandboxDriver('gha')).toBe('gh-actions');
    expect(selectSandboxDriver('gh-actions')).toBe('gh-actions');
    expect(selectSandboxDriver('local')).toBe('local');
  });

  it('uses OSA_SANDBOX_DRIVER when explicit driver is absent', () => {
    process.env.OSA_SANDBOX_DRIVER = 'gha';
    expect(selectSandboxDriver()).toBe('gh-actions');
  });

  it('creates the GitHub Actions adapter when driver is gha', async () => {
    const adapter = createSandboxAdapter({
      driver: 'gha',
      workspace,
      ghActionsOptions,
    });

    expect(createGhActionsSandboxAdapterMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ...ghActionsOptions,
        beforeDispatch: expect.any(Function),
      })
    );
    const ghArgs = createGhActionsSandboxAdapterMock.mock.calls[0][0];
    await ghArgs.beforeDispatch?.();
    expect(workspace.push).toHaveBeenCalledTimes(1);
    expect(createLocalSandboxAdapterMock).not.toHaveBeenCalled();
    expect(adapter).toBe(ghaHandle);
  });

  it('creates the local adapter for local driver', () => {
    const adapter = createSandboxAdapter({
      driver: 'local',
      workspace,
    });

    expect(createLocalSandboxAdapterMock).toHaveBeenCalledWith(workspace, undefined);
    expect(createGhActionsSandboxAdapterMock).not.toHaveBeenCalled();
    expect(adapter).toBe(localHandle);
  });

  it('throws when gh-actions driver is selected without ghActionsOptions', () => {
    expect(() =>
      createSandboxAdapter({
        driver: 'gha',
        workspace,
      })
    ).toThrow('createSandboxAdapter: gh-actions driver selected but ghActionsOptions missing');
  });
});
