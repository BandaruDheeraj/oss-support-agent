import {
  BaseRepoAdapter,
  type Issue,
  type PRMetadata,
} from '../../../core/adapter.interface';

export default class OpenInferenceAdapter extends BaseRepoAdapter {
  async classifyModule(_issue: Issue): Promise<string> {
    return '.';
  }

  async getPRMetadata(_issues: Issue[]): Promise<PRMetadata> {
    return { extraLabels: [], extraBodySections: [] };
  }
}
