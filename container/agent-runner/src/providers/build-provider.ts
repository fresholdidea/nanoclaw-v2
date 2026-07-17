import { createProvider } from './factory.js';
import { FallbackProvider } from './fallback.js';
import type { AgentProvider, ProviderOptions } from './types.js';
import type { RunnerConfig } from '../config.js';

export function buildProvider(config: RunnerConfig, options: ProviderOptions): AgentProvider {
  const chain = config.providerChain;
  if (chain && chain.length > 1) {
    const cooldownMs = (config.providerChainCooldownMinutes ?? 30) * 60 * 1000;
    return new FallbackProvider(chain, {
      createChild: (name) => createProvider(name, options),
      now: () => Date.now(),
      cooldownMs,
    });
  }
  return createProvider(config.provider.toLowerCase(), options);
}
