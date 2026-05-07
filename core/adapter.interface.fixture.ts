import { BaseRepoAdapter, type RepoAdapter } from '../core/adapter.interface';

class MinimalAdapter extends BaseRepoAdapter {}

// Compile-time contract test: `npm run lint` (tsc --noEmit) should fail if the interface changes.
const _adapter: RepoAdapter = new MinimalAdapter();
void _adapter;
