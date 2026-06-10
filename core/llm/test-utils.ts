/**
 * Test helpers for LLMClient consumers (US-100).
 */

import type {
  LLMChatOptions,
  LLMChatJsonOptions,
  LLMChatResult,
  LLMMessage,
  LLMUsage,
} from './types';

export interface LLMClientLike {
  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResult>;
  chatJson<T>(
    messages: LLMMessage[],
    schema: any,
    options?: LLMChatJsonOptions
  ): Promise<{ data: T; usage: LLMUsage | null; raw: unknown }>;
}

/**
 * Minimal mock LLM client that can be injected into agents in unit tests.
 */
export class MockLLMClient implements LLMClientLike {
  private readonly chatImpl: (messages: LLMMessage[], options?: LLMChatOptions) => Promise<LLMChatResult>;
  private readonly chatJsonImpl: <T>(
    messages: LLMMessage[],
    schema: any,
    options?: LLMChatJsonOptions
  ) => Promise<{ data: T; usage: LLMUsage | null; raw: unknown }>;

  constructor(impl?: Partial<{
    chat: (messages: LLMMessage[], options?: LLMChatOptions) => Promise<LLMChatResult>;
    chatJson: <T>(
      messages: LLMMessage[],
      schema: any,
      options?: LLMChatJsonOptions
    ) => Promise<{ data: T; usage: LLMUsage | null; raw: unknown }>;
  }>) {
    this.chatImpl = impl?.chat ?? (async () => {
      throw new Error('MockLLMClient.chat not implemented');
    });
    this.chatJsonImpl = impl?.chatJson ?? (async () => {
      throw new Error('MockLLMClient.chatJson not implemented');
    });
  }

  chat(messages: LLMMessage[], options?: LLMChatOptions): Promise<LLMChatResult> {
    return this.chatImpl(messages, options);
  }

  chatJson<T>(
    messages: LLMMessage[],
    schema: any,
    options?: LLMChatJsonOptions
  ): Promise<{ data: T; usage: LLMUsage | null; raw: unknown }> {
    return this.chatJsonImpl(messages, schema, options);
  }
}
