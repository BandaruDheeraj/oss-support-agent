/**
 * Tests for OpenRouterFixGenerator's failureDirective promotion (Phase 2 of
 * the make-repro-actually-work effort). The directive must end up at the TOP
 * of the user message — NOT buried inside the JSON-stringified input — and
 * must be stripped from the JSON body so the LLM doesn't see it twice in
 * conflicting forms.
 */

import { LLMClient } from './client';
import { MockLLMClient } from './test-utils';
import { OpenRouterFixGenerator } from './openrouter-fix-generator';
import type { FixAgentInput } from '../agents/fix-types';

function baseInput(): FixAgentInput {
  return {
    designSummary: 'Fix the bug',
    confirmedIssues: [
      { number: 23, title: 'Bug', body: 'broken', labels: [] },
    ],
    affectedModule: 'pkg/foo/',
    moduleSource: [{ path: 'pkg/foo/bar.py', content: 'def x(): return 1\n' }],
    moduleTests: [],
    recentCommits: [],
    forkFullName: 'fork/repo',
    branchName: 'fix/x',
  };
}

function fixOutput() {
  return {
    sourceChanges: [{ path: 'pkg/foo/bar.py', action: 'modify' as const, content: 'def x(): return 2\n' }],
    testChanges: [{ path: 'pkg/foo/tests/test_x.py', action: 'create' as const, content: '...' }],
    summary: 'fix',
  };
}

describe('OpenRouterFixGenerator failureDirective promotion', () => {
  test('omits preamble and JSON-includes nothing extra when directive is absent', async () => {
    let captured: { messages: any } | null = null;
    const llm = new MockLLMClient({
      chatJson: async <T>(messages: any) => {
        captured = { messages };
        return { data: fixOutput() as unknown as T, usage: null, raw: null };
      },
    }) as unknown as LLMClient;
    const gen = new OpenRouterFixGenerator(llm);
    await gen.generateFix(baseInput());
    const userMsg: string = captured!.messages[1].content;
    expect(userMsg).not.toContain('DIRECTIVE FROM PREVIOUS ATTEMPT');
    expect(userMsg).not.toContain('failureDirective');
    // Should still be parseable as JSON (no preamble means body == JSON).
    expect(() => JSON.parse(userMsg)).not.toThrow();
  });

  test('promotes failureDirective to the TOP of the user message and strips it from the JSON body', async () => {
    let captured: { messages: any } | null = null;
    const llm = new MockLLMClient({
      chatJson: async <T>(messages: any) => {
        captured = { messages };
        return { data: fixOutput() as unknown as T, usage: null, raw: null };
      },
    }) as unknown as LLMClient;
    const gen = new OpenRouterFixGenerator(llm);
    const directive = 'DO NOT include "tests/test_repro_issue_23.py" — it is read-only.';
    await gen.generateFix({ ...baseInput(), failureDirective: directive });

    const userMsg: string = captured!.messages[1].content;
    // 1. The directive sentinel appears literally and before the JSON body.
    expect(userMsg.startsWith('‼️ DIRECTIVE FROM PREVIOUS ATTEMPT')).toBe(true);
    expect(userMsg).toContain(directive);
    // 2. The directive's content is NOT inside the JSON body — the only
    //    occurrence of the directive text is in the preamble.
    const jsonStart = userMsg.indexOf('{');
    const jsonBody = userMsg.slice(jsonStart);
    expect(jsonBody).not.toContain(directive);
    expect(jsonBody).not.toContain('failureDirective');
    // 3. JSON body still parses cleanly.
    expect(() => JSON.parse(jsonBody)).not.toThrow();
  });

  test('treats whitespace-only directive as absent', async () => {
    let captured: { messages: any } | null = null;
    const llm = new MockLLMClient({
      chatJson: async <T>(messages: any) => {
        captured = { messages };
        return { data: fixOutput() as unknown as T, usage: null, raw: null };
      },
    }) as unknown as LLMClient;
    const gen = new OpenRouterFixGenerator(llm);
    await gen.generateFix({ ...baseInput(), failureDirective: '   \n  ' });
    const userMsg: string = captured!.messages[1].content;
    expect(userMsg).not.toContain('DIRECTIVE FROM PREVIOUS ATTEMPT');
  });

  test('system prompt mentions the directive precedence rule', async () => {
    let captured: { messages: any } | null = null;
    const llm = new MockLLMClient({
      chatJson: async <T>(messages: any) => {
        captured = { messages };
        return { data: fixOutput() as unknown as T, usage: null, raw: null };
      },
    }) as unknown as LLMClient;
    const gen = new OpenRouterFixGenerator(llm);
    await gen.generateFix(baseInput());
    const sys: string = captured!.messages[0].content;
    expect(sys).toContain('DIRECTIVE FROM PREVIOUS ATTEMPT');
  });
});
