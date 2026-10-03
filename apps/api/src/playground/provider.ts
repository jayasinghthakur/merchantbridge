import type Anthropic from '@anthropic-ai/sdk';
import type { LlmProviderName } from '../config';
import type { AgentRunOptions, RunAgentResult } from './engine';
import { runAgent } from './engine';
import type { OpenAiCompatibleLlm } from './openai-engine';
import { runAgentOpenAI } from './openai-engine';

/** How to reach the model, per provider (the model id is separate so evals can loop over models). */
export type LlmConnection =
  | {
      provider: 'anthropic';
      /** A client, or a lazy factory (the app context builds the client on first use). */
      anthropic: Anthropic | (() => Anthropic);
    }
  | ({ provider: 'openai' } & Omit<OpenAiCompatibleLlm, 'model'>);

/** A connection plus the model id: what the playground route and evals run an agent with. */
export type LlmRuntime = LlmConnection & { model: string };

export type AgentRunner = (opts: AgentRunOptions) => Promise<RunAgentResult>;

export const PROVIDER_LABELS: Readonly<Record<LlmProviderName, string>> = {
  openai: 'OpenAI-compatible',
  anthropic: 'Anthropic',
};

/**
 * Picks the engine for a provider: `runAgentOpenAI` (any OpenAI-compatible Chat Completions API, the free default)
 * or `runAgent` (Anthropic toolRunner). Both emit the same TraceEvents and return the same RunAgentResult.
 */
export function createAgentRunner(llm: LlmRuntime): AgentRunner {
  if (llm.provider === 'anthropic') {
    const source = llm.anthropic;
    return (opts) =>
      runAgent({
        ...opts,
        model: llm.model,
        anthropic: typeof source === 'function' ? source() : source,
      });
  }
  const { provider: _provider, ...openai } = llm;
  return (opts) => runAgentOpenAI({ ...opts, llm: openai });
}
