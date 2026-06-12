/**
 * EmailContext — the typed payload all 8 email templates render from.
 *
 * Templates are pure over this shape; the orchestrator builds the context
 * from dossier + repro/fix outcomes + links.
 */

import type { DossierSnapshot } from '../analyst/dossier';
import type { InvestigationNotes } from '../fix-loop/investigation-notes';

export interface EmailContext {
  to: string[];
  recipient: string;             // primary recipient for token binding
  attemptId: string;
  issueNumber: number;
  issueUrl: string | null;
  prNumber: number | null;
  prUrl: string | null;
  dossier?: DossierSnapshot | null;
  fixNotes?: InvestigationNotes | null;
  inboxEntryId: string;
  nonce: string;
  replyTo: string;
  expectedActions: string[];
  links: {
    arize: string | null;
    braintrust: string | null;
    pr: string | null;
    issue: string | null;
    approve?: string | null;
    requestChanges?: string | null;
    abandon?: string | null;
  };
  context: {
    summary?: string;
    failureSnippet?: string;        // stderr from repro or runVerification
    diffSummary?: string;
    changedFiles?: string[];
    fixApproach?: string;
    testsRunOutside?: string[];
    regressionStatus?: 'green' | 'red' | 'infra_error';
    failureKind?: string;           // e.g. 'sandbox_crash', 'missing_python', etc.
    humanQuestion?: string;
    missingCredential?: string;
    diff?: string;                  // raw git diff for fix_ready_for_review emails
    branchUrl?: string;
    commitSha?: string;
    reproTestPath?: string;
    reproTestUrl?: string;
    reproMethodNote?: string;
  };
}
