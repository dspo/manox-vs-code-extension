import type { ModelInfo } from '../../../protocol';

/** Resolve the picker's currently-selected model entry from a canonical
 * wire ref (L8). On the AHP wire the model row's `id` IS the full ref —
 * manox formats it `{provider}/{bare-id}` ("the wire never carries a bare
 * model id") — so the ref the picker sends and the id the registry
 * advertises are the same string; match is exact against `m.id`. */
export const findCurrentModel = (
  models: ModelInfo[],
  currentModelRef: string | null,
): ModelInfo | undefined =>
  currentModelRef === null
    ? undefined
    : models.find((m) => m.id === currentModelRef);
