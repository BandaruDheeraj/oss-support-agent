/**
 * v2 IssueHandle + RepoHandle adapters — pure structural mappers.
 */

import type { IssueEvent } from '../../webhook/types';
import type { IssueHandle, RepoHandle } from '../tools/handles';

export function createIssueHandle(payload: IssueEvent): IssueHandle {
  return {
    number: payload.issue.number,
    title: payload.issue.title,
    body: payload.issue.body ?? '',
    labels: payload.issue.labels?.map((l) => l.name) ?? [],
    url: `https://github.com/${payload.repository.full_name}/issues/${payload.issue.number}`,
  };
}

export function createRepoHandle(args: {
  payload: IssueEvent;
  forkFullName: string;
  branch: string;
  baselineSha: string;
  affectedModule: string;
  language: RepoHandle['language'];
}): RepoHandle {
  return {
    fullName: args.payload.repository.full_name,
    forkFullName: args.forkFullName,
    branch: args.branch,
    baselineSha: args.baselineSha,
    affectedModule: args.affectedModule,
    language: args.language,
  };
}
