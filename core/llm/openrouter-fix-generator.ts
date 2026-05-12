/**
 * OpenRouter-backed FixGenerator implementation (US-100).
 */

import type { FixAgentInput, FixGenerator, FixGeneratorOutput } from '../agents/fix-types';
import { LLMClient, type LLMMessage } from './client';

const FIX_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sourceChanges', 'testChanges', 'summary'],
  properties: {
    sourceChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'content'],
        properties: {
          path: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['modify', 'create'] },
          content: { type: 'string' },
        },
      },
    },
    testChanges: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'action', 'content'],
        properties: {
          path: { type: 'string', minLength: 1 },
          action: { type: 'string', enum: ['modify', 'create'] },
          content: { type: 'string' },
        },
      },
    },
    sourcePatches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'oldText', 'newText'],
        properties: {
          path: { type: 'string', minLength: 1 },
          oldText: { type: 'string', minLength: 1 },
          newText: { type: 'string' },
        },
      },
    },
    testPatches: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'oldText', 'newText'],
        properties: {
          path: { type: 'string', minLength: 1 },
          oldText: { type: 'string', minLength: 1 },
          newText: { type: 'string' },
        },
      },
    },
    summary: { type: 'string', minLength: 1 },
  },
} as const;

export class OpenRouterFixGenerator implements FixGenerator {
  private readonly client: LLMClient;

  constructor(client?: LLMClient) {
    this.client = client ?? new LLMClient();
  }

  async generateFix(input: FixAgentInput): Promise<FixGeneratorOutput> {
    // Strip failureDirective from the JSON body — we'll promote it to a
    // dedicated preamble at the TOP of the user message so the LLM cannot
    // miss it, mirroring what we do in OpenRouterIterativeReproGenerator.
    const { failureDirective, ...inputForJson } = input;
    const userParts: string[] = [];
    if (failureDirective && failureDirective.trim().length > 0) {
      userParts.push(
        '‼️ DIRECTIVE FROM PREVIOUS ATTEMPT — READ FIRST, OBEY UNCONDITIONALLY:',
        failureDirective.trim(),
        '',
        '↑ If you ignore the directive above, this attempt will be rejected the same way the last one was. ' +
        'Read it, then read the rest of the input.',
        '',
      );
    }
    userParts.push(JSON.stringify(inputForJson, null, 2));

    const messages: LLMMessage[] = [
      {
        role: 'system',
        content:
          'You are a software engineer agent generating a targeted patch. ' +
          'Return JSON with this exact shape:\n' +
          '{\n' +
          '  "sourceChanges": [{"path": string, "action": "modify"|"create", "content": string}],\n' +
          '  "testChanges":   [{"path": string, "action": "modify"|"create", "content": string}],\n' +
          '  "sourcePatches": [{"path": string, "oldText": string, "newText": string}],\n' +
          '  "testPatches":   [{"path": string, "oldText": string, "newText": string}],\n' +
          '  "summary": string\n' +
          '}\n' +
          'You have TWO ways to express an edit:\n' +
          '  • PATCHES (sourcePatches / testPatches) — STRONGLY PREFERRED for any modification ' +
          'to an existing file. Each entry names a path and a UNIQUE block of existing code ' +
          '("oldText", at least 3 contiguous lines including indentation, copied byte-for-byte ' +
          'from the file as it appears on the branch) plus the replacement ("newText"). The fix ' +
          'pipeline reads the file and substitutes the block. This is the ONLY reliable way to ' +
          'edit files larger than ~10KB — full-file reproduction silently fails on long files.\n' +
          '  • FULL CONTENT (sourceChanges / testChanges) — required ONLY for action="create" ' +
          '(new files), or when modifying very small files where you are 100% confident you can ' +
          'reproduce every byte. When action="modify" you MUST reproduce the entire file ' +
          'verbatim including every line you are NOT changing. NEVER abbreviate, truncate, or ' +
          'replace existing code with placeholders ("# ...existing code...", "// ... rest ...", ' +
          '"# omitted for brevity", or any ellipsis-based summary).\n' +
          'CHOOSING BETWEEN THEM: if the target file is more than ~150 lines OR the change is ' +
          'localised to a small region, USE A PATCH. Patches with a 3-10 line oldText window are ' +
          'always safer than full-file rewrites. Reserve sourceChanges for new-file creation.\n' +
          'PATCH RULES:\n' +
          '  • oldText must appear EXACTLY ONCE in the file. If a 3-line block would match in ' +
          'multiple places, expand it (5-10 lines) until it is unique.\n' +
          '  • Copy oldText byte-for-byte from the file (same indentation, same whitespace, same ' +
          'newlines). A single character mismatch will cause the patch to be rejected.\n' +
          '  • newText replaces the entire oldText block — include any unchanged surrounding ' +
          'lines from oldText that you want preserved in the output.\n' +
          '  • For an addition with no removal, set oldText to a unique anchor line and set ' +
          'newText to that same anchor line plus your inserted lines.\n' +
          'GENERAL RULES:\n' +
          'Only touch files within the affected module and related tests. ' +
          'IMPORTANT: If sourceChanges or sourcePatches is non-empty AND no "reproTest" is provided, ' +
          'testChanges or testPatches MUST also be non-empty. ' +
          'For documentation-only fixes (README, AGENTS.md, CHANGELOG, etc.) where no executable test makes sense, ' +
          'add a trivial test entry such as a tests/test_docs_smoke.py with a single assertion that the doc file ' +
          'exists and is non-empty. Do not omit testChanges. ' +
          'REPRO TEST: If the input has a "reproTest" field, a reproduction test already exists ' +
          'on the branch at that path that currently FAILS on the bug. Your fix MUST make it ' +
          'pass (exit code 0). UNDER NO CIRCUMSTANCES include the reproTest path in any of the ' +
          'four arrays — it is read-only. Do not weaken its assertions, do not delete it, do ' +
          'not move it. Fix the underlying bug so the existing repro passes as-is. ' +
          'When a "reproTest" is present, the repro IS your test coverage — testChanges and ' +
          'testPatches should both be empty arrays. Do NOT add unrelated smoke tests, ' +
          'README-exists assertions, or any other new test files; doing so will get those files ' +
          'stripped post-fix. ' +
          'Likewise, do NOT reformat unrelated functions or whitespace — only emit hunks that ' +
          'directly change behaviour to address the bug. ' +
          'If the user message begins with a "‼️ DIRECTIVE FROM PREVIOUS ATTEMPT" block, ' +
          'that directive takes precedence over your own judgment about what to do next: ' +
          'the previous attempt was rejected for a specific reason and the directive tells ' +
          'you exactly how to avoid the same rejection. ' +
          'Do not include any properties other than path, action, content (for changes) or ' +
          'path, oldText, newText (for patches).',
      },
      {
        role: 'user',
        content: userParts.join('\n'),
      },
    ];

    const { data } = await this.client.chatJson<FixGeneratorOutput>(messages, FIX_OUTPUT_SCHEMA, {
      agent: 'FIX',
      temperature: 0,
    });

    // Diagnostic: surface what the LLM returned so we can tell whether
    // "No changes to commit" is caused by empty arrays vs no-op content.
    const sourceSummary = (data.sourceChanges ?? [])
      .map((c) => `${c.action} ${c.path} (${(c.content ?? '').length}b)`)
      .join('; ');
    const testSummary = (data.testChanges ?? [])
      .map((c) => `${c.action} ${c.path} (${(c.content ?? '').length}b)`)
      .join('; ');
    const sourcePatchSummary = (data.sourcePatches ?? [])
      .map((p) => `${p.path} (-${(p.oldText ?? '').length}b/+${(p.newText ?? '').length}b)`)
      .join('; ');
    const testPatchSummary = (data.testPatches ?? [])
      .map((p) => `${p.path} (-${(p.oldText ?? '').length}b/+${(p.newText ?? '').length}b)`)
      .join('; ');
    console.log(
      `[fix-gen] returned sourceChanges=${(data.sourceChanges ?? []).length} ` +
        `testChanges=${(data.testChanges ?? []).length} ` +
        `sourcePatches=${(data.sourcePatches ?? []).length} ` +
        `testPatches=${(data.testPatches ?? []).length} ` +
        `summaryLen=${(data.summary ?? '').length}`
    );
    if (sourceSummary) console.log(`[fix-gen] source: ${sourceSummary}`);
    if (testSummary) console.log(`[fix-gen] tests:  ${testSummary}`);
    if (sourcePatchSummary) console.log(`[fix-gen] sourcePatches: ${sourcePatchSummary}`);
    if (testPatchSummary) console.log(`[fix-gen] testPatches:  ${testPatchSummary}`);
    if ((data.summary ?? '').trim()) {
      console.log(`[fix-gen] summary: ${data.summary.slice(0, 240)}`);
    }

    return data;
  }
}
