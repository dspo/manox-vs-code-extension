import { describe, expect, it } from 'vitest';

import type { ModelInfo } from '../../../protocol';
import { findCurrentModel } from './current-model';

// On the AHP wire the model row's `id` IS the canonical ref — manox formats
// it `{provider}/{bare-id}` ("the wire never carries a bare model id") — so
// the fixtures carry full-ref ids, the same strings the picker sends.
const models: ModelInfo[] = [
  {
    id: 'DeepSeek-anthropic/deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    provider: 'DeepSeek-anthropic',
    provider_name: 'DeepSeek',
    api: 'anthropic',
    context_window: 200000,
  },
  {
    id: 'DeepSeek-responses/deepseek-v4-pro',
    name: 'deepseek-v4-pro',
    provider: 'DeepSeek-responses',
    provider_name: 'DeepSeek',
    api: 'openai_responses',
    context_window: 200000,
  },
];

describe('findCurrentModel', () => {
  it('matches the canonical ref exactly (each wire variant resolvable)', () => {
    const current = findCurrentModel(models, 'DeepSeek-responses/deepseek-v4-pro');
    expect(current?.provider).toBe('DeepSeek-responses');
    const other = findCurrentModel(models, 'DeepSeek-anthropic/deepseek-v4-pro');
    expect(other?.provider).toBe('DeepSeek-anthropic');
  });
  it('never resolves a bare id (L8: the wire carries none)', () => {
    expect(findCurrentModel(models, 'deepseek-v4-pro')).toBeUndefined();
  });
  it('returns undefined for null or unknown refs', () => {
    expect(findCurrentModel(models, null)).toBeUndefined();
    expect(findCurrentModel(models, 'no-such-provider/deepseek-v4-pro')).toBeUndefined();
    expect(findCurrentModel([], 'DeepSeek-anthropic/deepseek-v4-pro')).toBeUndefined();
  });
});
