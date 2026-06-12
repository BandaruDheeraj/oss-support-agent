/** Shared LLM type definitions used across the codebase. */

export type LLMRole = 'system' | 'user' | 'assistant';

export interface LLMMessage {
  role: LLMRole;
  content: string;
  name?: string;
}

export interface LLMUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMChatResult {
  content: string;
  usage: LLMUsage | null;
  raw: unknown;
}

export type OpenRouterAgent =
  | 'TRIAGE'
  | 'PM'
  | 'FIX'
  | 'BUILD'
  | 'EVAL'
  | 'DOCS'
  | 'USABILITY'
  | 'INTROSPECTION'
  | 'REPRO';

export interface LLMChatOptions {
  /** OpenRouterAgent or any PhaseEAgent string (e.g. 'REPRO_ASSEMBLER'). */
  agent?: string;
  model?: string;
  temperature?: number;
  onUsage?: (usage: LLMUsage) => void;
  maxTokens?: number;
}

export interface LLMChatJsonOptions extends LLMChatOptions {
  parseRetries?: number;
}
