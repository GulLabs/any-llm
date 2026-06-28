/**
 * @anyllm/testing — reusable test fakes for the any-llm library.
 *
 * ```ts
 * import {
 *   FakeClock,
 *   FakeIds,
 *   RecordingSink,
 *   fakeGeminiResponse,
 *   makeFakeGemini,
 * } from '@anyllm/testing'
 * ```
 *
 * @module
 */

export { FakeClock } from './clock.js'
export { FakeIds } from './ids.js'
export { RecordingSink } from './recording-sink.js'
export type { RecordingSinkOptions } from './recording-sink.js'
export {
  fakeGeminiResponse,
  fakeGeminiBlocked,
  makeFakeGemini,
} from './fake-gemini.js'
export type {
  GeminiPartLike,
  GeminiContentLike,
  GeminiCandidateLike,
  GeminiUsageMetadataLike,
  GeminiResponseLike,
  FakeGeminiResponseOpts,
  FakeGeminiBlockedOpts,
  GeminiScript,
  FakeGeminiModels,
  FakeGeminiClient,
} from './fake-gemini.js'
export { FakeAdapter, fakeAuth } from './fake-adapter.js'
export type { FakeAdapterEntry } from './fake-adapter.js'
export { SignalAwareFakeAdapter } from './signal-aware-fake-adapter.js'
export type { SignalAwareFakeAdapterOptions } from './signal-aware-fake-adapter.js'
