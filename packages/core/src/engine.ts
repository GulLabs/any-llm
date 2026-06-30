/**
 * Engine for @gullabs/core — the heart of the library.
 *
 * {@link createClient} wires together all port implementations and returns a
 * `{ generate, runStructured }` client.  Every LLM call goes through the same
 * 12-step pipeline (config resolution → adapter → normalize → validate → cost
 * → record → result), ensuring consistent observability and fail-open side
 * effects regardless of call path.
 *
 * @module
 */

import { randomUUID } from 'node:crypto'
import type { StandardSchemaV1 } from './standard-schema.js'
import { LlmError, classifyError } from './errors.js'
import { buildRecord, normalizeUsage } from './record.js'
import type { ModelRegistry } from './registry.js'
import { defaultGeminiRegistry } from './registry.js'
import type {
  ProviderAdapter,
  AdapterResult,
  AuthMaterial,
  PricingSource,
  UsageSink,
  Clock,
  IdGenerator,
  Logger,
  Telemetry,
  RateLimiter,
  Release,
  ResolvedRequest,
  AdapterCtx,
  Middleware,
  EngineCtx,
  Handler,
  CallStartEvent,
  CallSuccessEvent,
  CallErrorEvent,
} from './ports.js'
import type {
  LlmRequest,
  LlmResult,
  GenConfig,
  CallMetadata,
  Usage,
  Warning,
  Cost,
} from './types.js'
import type { CallSite } from './callsite.js'

// ---------------------------------------------------------------------------
// Public config types
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link createClient}.
 */
export interface ClientConfig {
  /**
   * One or more provider adapters.  When a single adapter is provided the
   * engine uses it unconditionally.  With multiple adapters, the default
   * router picks by derived provider (e.g. `gemini-*` → `'google'`); supply
   * a custom `route` function to override.
   */
  adapters: ProviderAdapter[]
  /** Pricing table used to compute micro-USD cost for each call. */
  pricing: PricingSource
  /**
   * Where completed call records are persisted.
   * Failures are logged and swallowed (fail-open) — a broken sink must never
   * fail the LLM call.
   */
  sink?: UsageSink
  /**
   * Time source.  Defaults to `{ now: () => Date.now() }`.
   * Inject {@link FakeClock} in tests for deterministic latency assertions.
   */
  clock?: Clock
  /**
   * Unique ID generator.  Defaults to `crypto.randomUUID()`.
   * Inject {@link FakeIds} in tests for deterministic record assertions.
   */
  ids?: IdGenerator
  /**
   * Structured logger.  Defaults to a no-op implementation.
   * Canonical event names: `llm.call.start`, `llm.call.success`, `llm.call.error`.
   */
  logger?: Logger
  /**
   * Optional observability hook (Sentry / PostHog / OTel).
   * All callbacks are optional; failures are swallowed (fail-open).
   */
  telemetry?: Telemetry
  /**
   * Pre-send pacing / backpressure implementation.
   *
   * Called with key `"${provider}:${model}"` before the adapter is invoked.
   * A rejection from `acquire` propagates (NOT fail-open) — the call fails.
   *
   * Defaults to a no-op limiter ({@link NOOP_RATE_LIMITER}) that resolves
   * immediately with a no-op Release.
   */
  rateLimiter?: RateLimiter
  /**
   * Library-level generation defaults.
   * Merged under call-site config and per-call config (lowest priority).
   */
  defaults?: GenConfig
  /**
   * Custom adapter router.
   * Receives the model string and the full adapter list; returns the adapter
   * to use.  Defaults to: single adapter → use it; multiple → match by
   * derived provider prefix (`gemini-*` → `'google'`); no match → throw
   * `LlmError('bad_request')`.
   */
  route?(model: string, adapters: ProviderAdapter[]): ProviderAdapter
  /**
   * Model registry used to derive the provider from a model string.
   * Defaults to {@link defaultGeminiRegistry} (all models in the Gemini
   * pricing snapshot).  Supply a custom registry to add new models or
   * override provider mappings without forking the library.
   */
  modelRegistry?: ModelRegistry
  /**
   * Ordered middleware stack applied to every call, outermost-first.
   *
   * The first element is the outermost (first to receive the request, last to
   * see the response).  The engine's `runAttempt` function is the innermost
   * handler.
   *
   * Each middleware's `id` must be unique across the array; `createClient`
   * throws `LlmError('bad_request')` on duplicates.
   *
   * @example
   * ```ts
   * middleware: [retryMiddleware({ maxAttempts: 3 })]
   * ```
   */
  middleware?: Middleware[]
}

/**
 * Options accepted by {@link Client.generate}.
 */
export interface GenerateOptions {
  /** API key credentials for this call. Required on every call. */
  auth: AuthMaterial
  /** Caller-supplied abort signal. Classifies as `'aborted'` when fired. */
  signal?: AbortSignal
}

/**
 * Options accepted by {@link Client.runStructured}.
 */
export interface RunStructuredOptions {
  /** API key credentials for this call. Required on every call. */
  auth: AuthMaterial
  /**
   * Per-call generation config override.
   * Wins over call-site defaults; loses to nothing.
   */
  config?: GenConfig
  /** Caller-supplied abort signal. Classifies as `'aborted'` when fired. */
  signal?: AbortSignal
  /** Per-call metadata anchors merged into the persisted record. */
  metadata?: CallMetadata
}

/**
 * The client returned by {@link createClient}.
 */
export interface Client {
  /**
   * Execute a single LLM call described by an {@link LlmRequest}.
   *
   * Config resolution: `clientDefaults → request.config`.
   * `opts.auth` is required on every call — the library never reads credentials
   * from the environment.
   *
   * @returns A typed {@link LlmResult} on success; throws {@link LlmError} on failure.
   */
  generate<S extends StandardSchemaV1>(
    request: LlmRequest<S>,
    opts: GenerateOptions,
  ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>>

  /**
   * Execute an LLM call described by a {@link CallSite} with per-call overrides.
   *
   * Config resolution: `clientDefaults → callSite.config → opts.config`.
   * `opts.auth` is required on every call.
   *
   * @returns A typed {@link LlmResult} with `output` typed to the call-site schema.
   */
  runStructured<S extends StandardSchemaV1>(
    callSite: CallSite<S>,
    opts: RunStructuredOptions,
  ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>>

  /**
   * Execute an LLM call described by a {@link CallSite} with template variables
   * and per-call overrides.
   *
   * Config resolution: `clientDefaults → callSite.config → opts.config`.
   * Template interpolation: `{{var}}` in `system` and `userTemplate` is
   * replaced with the corresponding value from `vars`.  Var values are NOT
   * themselves interpolated (anti-injection).  Missing vars are left as the
   * literal `{{var}}` placeholder.
   * `opts.auth` is required on every call.
   *
   * @returns A typed {@link LlmResult} with `output` typed to the call-site schema.
   */
  runStructured<S extends StandardSchemaV1>(
    callSite: CallSite<S>,
    vars: Record<string, string>,
    opts: RunStructuredOptions,
  ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>>
}

// ---------------------------------------------------------------------------
// Internal constants / defaults
// ---------------------------------------------------------------------------

const NOOP_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
}

const NOOP_TELEMETRY: Telemetry = {}

/**
 * A no-op {@link RateLimiter} that resolves immediately with a no-op Release.
 * Used when no `rateLimiter` is configured in {@link ClientConfig}.
 */
const NOOP_RATE_LIMITER: RateLimiter = {
  async acquire(_key: string, _signal?: AbortSignal): Promise<Release> {
    return () => {}
  },
}

const DEFAULT_IDS: IdGenerator = {
  callId: () => randomUUID(),
  attemptId: () => randomUUID(),
}

const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
}

/** Sentinel empty usage for error-path records when the adapter never returned. */
const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  details: {},
  raw: null,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Non-recursive `{{var}}` template interpolation.
 *
 * Replacement values are substituted verbatim — they are NOT re-scanned for
 * further `{{...}}` patterns, preventing template-injection attacks where a
 * user-supplied value could expand to another placeholder.
 *
 * Missing vars (key not present in `vars`) are left as the original `{{var}}`
 * placeholder so the absence is visible rather than silently producing an
 * empty string.
 */
function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    return Object.prototype.hasOwnProperty.call(vars, key)
      ? (vars[key] ?? match)
      : match
  })
}

/**
 * Returns `true` when `v` is a plain object (`{}` literal or `Object.create(null)`),
 * excluding Arrays, Dates, and other built-in object types.
 *
 * Used to decide whether two values should be recursively merged or whether
 * the right-hand side should win outright (last-write-wins for scalars and arrays).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Recursively merges two plain objects, left-to-right.
 *
 * - Nested plain objects: merged recursively.
 * - Arrays and scalar values: last-write-wins (the `override` value replaces `base`).
 */
function deepMergePlain(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const bv = base[key]
    const ov = override[key]
    if (isPlainObject(bv) && isPlainObject(ov)) {
      result[key] = deepMergePlain(bv, ov)
    } else {
      result[key] = ov
    }
  }
  return result
}

/**
 * Deep-merges {@link GenConfig} objects left-to-right (later entries win).
 *
 * Scalar fields (`temperature`, `topP`, etc.) use last-write-wins.
 * Object fields (`reasoning`, `providerOptions`) are recursively merged so a
 * per-call override can set individual sub-keys without replacing the entire
 * object (and without dropping sibling keys inside nested provider blocks).
 * Arrays and non-object values within those objects are last-write-wins.
 */
function deepMergeConfig(...configs: Array<GenConfig | undefined>): GenConfig {
  const acc: Record<string, unknown> = {}
  for (const cfg of configs) {
    if (cfg === undefined) continue
    const keys = Object.keys(cfg) as Array<keyof GenConfig>
    for (const key of keys) {
      const val = cfg[key]
      if (val === undefined) continue
      if (key === 'reasoning' && isPlainObject(val)) {
        const current = acc[key]
        acc[key] = deepMergePlain(isPlainObject(current) ? current : {}, val)
      } else if (key === 'providerOptions' && isPlainObject(val)) {
        const current = acc[key]
        acc[key] = deepMergePlain(isPlainObject(current) ? current : {}, val)
      } else {
        acc[key] = val
      }
    }
  }
  return acc as GenConfig
}

/**
 * Merges multiple AbortSignals into a single signal that fires when any input
 * fires.  Immediately resolved if any input is already aborted.
 * Returns both the merged signal and a cleanup function that removes all
 * registered event listeners to prevent leaks.
 */
function mergeSignals(signals: AbortSignal[]): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController()
  const cleanups: Array<() => void> = []
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      return { signal: controller.signal, cleanup() {} }
    }
    const handler = () => { controller.abort(sig.reason) }
    sig.addEventListener('abort', handler, { once: true })
    cleanups.push(() => sig.removeEventListener('abort', handler))
  }
  return {
    signal: controller.signal,
    cleanup() {
      for (const fn of cleanups) fn()
    },
  }
}

/**
 * Derives the provider identifier from a model string for routing and records.
 *
 * Resolution order:
 * 1. Registry descriptor — uses `descriptor.provider` when found.
 * 2. `provider/model` slash convention → `provider`.
 * 3. `'unknown'` when nothing matches.
 */
function deriveProvider(model: string, registry: ModelRegistry): string {
  const descriptor = registry.resolve(model)
  if (descriptor !== undefined) return descriptor.provider
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(0, slash)
  return 'unknown'
}

/**
 * Default router: use the single adapter when only one is configured; otherwise
 * match by derived provider from the model string using the prebuilt adapter map.
 *
 * @throws {@link LlmError} `'bad_request'` when no matching adapter is found.
 */
function defaultRoute(
  model: string,
  adapters: ProviderAdapter[],
  adapterMap: Map<string, ProviderAdapter>,
  registry: ModelRegistry,
): ProviderAdapter {
  if (adapters.length === 0) {
    throw new LlmError('No adapters configured', {
      kind: 'bad_request',
      retryable: false,
    })
  }
  if (adapters.length === 1) {
    return adapters[0]!
  }
  const provider = deriveProvider(model, registry)
  const found = adapterMap.get(provider)
  if (found === undefined) {
    throw new LlmError(
      `No adapter found for model "${model}" (derived provider: "${provider}")`,
      { kind: 'bad_request', retryable: false },
    )
  }
  return found
}

// ---------------------------------------------------------------------------
// Pipeline helper: cancellation race
// ---------------------------------------------------------------------------

/**
 * Builds the cancellation scaffolding for a single pipeline invocation.
 *
 * Returns:
 *  - `raceParts`      — rejection promises to include in every `Promise.race`.
 *  - `combinedSignal` — merged abort signal forwarded to the adapter.
 *  - `cleanup()`      — idempotent; clears the timer and removes the
 *                       caller-abort listener.  Safe to call on both the
 *                       success path and the catch block.
 *
 * Invariant A (timeout-beats-abort microtask ordering):
 *   The timeout `setTimeout` callback rejects the timeout promise BEFORE
 *   calling `timeoutController.abort()`.  This guarantees `kind:'timeout'`
 *   wins `Promise.race` even against a synchronously-aborting adapter.
 *   Do not reorder the two operations inside the timer callback.
 */
function buildCancellationRace(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): { raceParts: Array<Promise<never>>; combinedSignal: AbortSignal | undefined; cleanup(): void } {
  const raceParts: Array<Promise<never>> = []

  let timer: ReturnType<typeof setTimeout> | undefined
  let callerAbortCleanup: (() => void) | undefined

  // ── (a) Caller-abort race promise ────────────────────────────────────────
  // adapter.run() is raced against a rejection promise that fires when
  // callerSignal fires, ensuring caller cancellation always terminates the
  // call even if the adapter ignores ctx.signal.  Already-aborted signals
  // are handled synchronously via a pre-rejected promise.
  if (callerSignal !== undefined) {
    if (callerSignal.aborted) {
      // Already aborted — pre-rejected promise settles the race immediately.
      raceParts.push(
        Promise.reject<never>(
          new LlmError('Request aborted by caller', {
            kind: 'aborted',
            retryable: false,
            ...(callerSignal.reason !== undefined
              ? { cause: callerSignal.reason as unknown }
              : {}),
          }),
        ),
      )
    } else {
      // Not yet aborted — create a promise that rejects when the signal fires.
      let abortRejectFn!: (err: LlmError) => void
      const abortPromise = new Promise<never>((_, reject) => {
        abortRejectFn = reject
      })
      const abortHandler = () => {
        abortRejectFn(
          new LlmError('Request aborted by caller', {
            kind: 'aborted',
            retryable: false,
            ...(callerSignal.reason !== undefined
              ? { cause: callerSignal.reason as unknown }
              : {}),
          }),
        )
      }
      callerSignal.addEventListener('abort', abortHandler, { once: true })
      callerAbortCleanup = () =>
        callerSignal.removeEventListener('abort', abortHandler)
      raceParts.push(abortPromise)
    }
  }

  // ── (b) Timeout race promise ──────────────────────────────────────────────
  // Determinism guarantee (Finding 2 / Invariant A):
  //   The timeout promise rejects BEFORE its AbortController is fired.
  //   This means even a signal-aware adapter that throws AbortError
  //   synchronously on the abort signal cannot win the race with kind:'aborted'
  //   when the real cause was a timeout.
  let timeoutController: AbortController | undefined
  if (timeoutMs !== undefined) {
    timeoutController = new AbortController()
    const ms = timeoutMs
    let timeoutRejectFn!: (err: LlmError) => void
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutRejectFn = reject
    })
    timer = setTimeout(() => {
      // REJECT FIRST — schedules the 'timeout' LlmError into the microtask
      // queue before the abort signal fires.  This guarantees 'timeout' wins
      // Promise.race even when the adapter rejects synchronously on abort.
      timeoutRejectFn(
        new LlmError(`Request timed out after ${ms}ms`, {
          kind: 'timeout',
          retryable: true,
        }),
      )
      // Abort AFTER scheduling the rejection — cooperative adapters stop early.
      timeoutController!.abort()
    }, ms)
    raceParts.push(timeoutPromise)
  }

  // Build combined signal for cooperative adapters (caller + timeout merged).
  const signalParts: AbortSignal[] = []
  if (callerSignal !== undefined) signalParts.push(callerSignal)
  if (timeoutController !== undefined) signalParts.push(timeoutController.signal)

  let mergedSignalCleanup: (() => void) | undefined
  const combinedSignal: AbortSignal | undefined =
    signalParts.length === 0
      ? undefined
      : signalParts.length === 1
        ? signalParts[0]
        : (() => {
            const merged = mergeSignals(signalParts)
            mergedSignalCleanup = merged.cleanup
            return merged.signal
          })()

  // Idempotent cleanup — safe to call on both success and error paths.
  function cleanup(): void {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    callerAbortCleanup?.()
    callerAbortCleanup = undefined
    mergedSignalCleanup?.()
    mergedSignalCleanup = undefined
  }

  return { raceParts, combinedSignal, cleanup }
}

// ---------------------------------------------------------------------------
// Pipeline helper: record builders
// ---------------------------------------------------------------------------

/** Resolved config type used throughout the pipeline. */
type ResolvedConfig = Required<Pick<GenConfig, 'serviceTier'>> & GenConfig

/**
 * Assembles the {@link LlmCallRecord} for the success path (Step 10).
 */
function buildSuccessRecord(
  callId: string,
  attemptId: string,
  callSiteId: string | undefined,
  provider: string,
  model: string,
  metadata: CallMetadata | undefined,
  resolvedConfig: ResolvedConfig,
  adapterResult: AdapterResult,
  normalizedUsage: Usage,
  cost: Cost | undefined,
  allWarnings: Warning[],
  latencyMs: number,
  startMs: number,
): ReturnType<typeof buildRecord> {
  return buildRecord({
    callId,
    attemptId,
    ...(callSiteId !== undefined ? { callSiteId } : {}),
    provider,
    model,
    ...(adapterResult.modelVersion !== undefined
      ? { modelVersion: adapterResult.modelVersion }
      : {}),
    ...(adapterResult.responseId !== undefined
      ? { responseId: adapterResult.responseId }
      : {}),
    serviceTier: resolvedConfig.serviceTier,
    usage: normalizedUsage,
    ...(cost !== undefined ? { cost } : {}),
    latencyMs,
    status: 'ok',
    ...(adapterResult.finishReason !== undefined
      ? { finishReason: adapterResult.finishReason }
      : {}),
    warnings: allWarnings,
    generationConfig: resolvedConfig,
    metadata: metadata ?? {},
    createdAt: new Date(startMs).toISOString(),
    ...(adapterResult.reasoningText !== undefined
      ? { reasoningText: adapterResult.reasoningText }
      : {}),
    ...(adapterResult.providerMetadata !== undefined
      ? { providerMetadata: adapterResult.providerMetadata }
      : {}),
  })
}

/**
 * Assembles the {@link LlmCallRecord} for the error path (catch block postmortem).
 */
function buildErrorRecord(
  callId: string,
  attemptId: string,
  callSiteId: string | undefined,
  provider: string,
  model: string,
  metadata: CallMetadata | undefined,
  resolvedConfig: ResolvedConfig,
  usage: Usage,
  latencyMs: number,
  startMs: number,
  err: LlmError,
): ReturnType<typeof buildRecord> {
  return buildRecord({
    callId,
    attemptId,
    ...(callSiteId !== undefined ? { callSiteId } : {}),
    provider,
    model,
    usage,
    latencyMs,
    // buildRecord overrides status from error.kind via errorKindToStatus.
    status: 'api_error',
    generationConfig: resolvedConfig,
    metadata: metadata ?? {},
    createdAt: new Date(startMs).toISOString(),
    error: err,
  })
}

// ---------------------------------------------------------------------------
// Pipeline helper: fail-open sink write
// ---------------------------------------------------------------------------

/**
 * Writes `record` to `sink` if a sink is configured.
 * Failures are logged and swallowed (fail-open) — a broken sink must never
 * fail the LLM call.
 */
async function recordToSink(
  sink: UsageSink | undefined,
  record: ReturnType<typeof buildRecord>,
  logger: Logger,
  callId: string,
): Promise<void> {
  if (sink !== undefined) {
    try {
      await sink.record(record)
    } catch (sinkErr) {
      logger.error({ callId, error: String(sinkErr) }, 'llm.call.sink.failed')
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helper: attach call context to errors (idempotent)
// ---------------------------------------------------------------------------

/**
 * Attaches `callId` and `attemptId` to an `LlmError` if not already set.
 *
 * `LlmError` fields are `readonly` at the TypeScript level (compile-time only).
 * We use `Object.defineProperty` to set them at runtime when they were not
 * supplied to the constructor — which is the case for errors thrown by adapters
 * before the engine had a chance to enrich them.
 *
 * This helper is idempotent: if either field is already set, it is left as-is.
 */
function attachCallContext(
  err: LlmError,
  ctx: { callId: string; attemptId?: string },
): void {
  if (err.callId === undefined) {
    Object.defineProperty(err, 'callId', {
      value: ctx.callId,
      enumerable: true,
      configurable: true,
    })
  }
  if (ctx.attemptId !== undefined && err.attemptId === undefined) {
    Object.defineProperty(err, 'attemptId', {
      value: ctx.attemptId,
      enumerable: true,
      configurable: true,
    })
  }
}

// ---------------------------------------------------------------------------
// createClient
// ---------------------------------------------------------------------------

/**
 * Wire together port implementations and return a ready-to-use {@link Client}.
 *
 * The client is stateless and thread-safe; share it across requests.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   adapters: [geminiAdapter()],
 *   pricing: geminiPricingSource(),
 *   sink: drizzleUsageSink(db, llmCallsTable),
 * })
 *
 * const result = await client.generate(
 *   { model: 'gemini-2.5-pro', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }] },
 *   { auth: { apiKey: process.env['GEMINI_API_KEY']! } },
 * )
 * ```
 */
/**
 * Validates per-call auth material and returns the concrete {@link AuthMaterial}
 * that is threaded through {@link AdapterCtx} for the rest of the call.
 *
 * This is the **canonical auth-resolution point** — auth is resolved once per
 * logical call, before the middleware chain runs, and the concrete result is
 * forwarded unchanged through every retry attempt via `AdapterCtx`.
 *
 * **Future: refreshable credentials** (short-lived OAuth/STS tokens).
 * When that need arises, widen the `opts.auth` type on {@link GenerateOptions}
 * and {@link RunStructuredOptions} to
 * `AuthMaterial | ((ctx: RefreshCtx) => Promise<AuthMaterial>)`,
 * resolve the resolver HERE (once per logical call, not per attempt), and
 * continue threading the concrete `AuthMaterial` through `AdapterCtx` unchanged.
 *
 * Open policy questions to settle at that time:
 * - Resolve once per logical call vs. once per retry attempt (current proposal:
 *   once per call — simpler, keeps retry semantics predictable).
 * - How to handle a mid-attempt credential expiry (current: not in scope; the
 *   resolver is called at call start, not between retries).
 * - Resolver failures: classify as `invalid_auth` (non-retryable) and skip
 *   the adapter entirely, or allow retry? (Current proposal: `invalid_auth`,
 *   non-retryable — same as a missing key.)
 *
 * Throws `LlmError('invalid_auth')` when auth is missing or contains an
 * empty/non-string apiKey.
 */
function requireAuth(auth: AuthMaterial | undefined): AuthMaterial {
  if (auth === undefined || typeof auth.apiKey !== 'string' || auth.apiKey.trim() === '') {
    throw new LlmError('Missing or invalid auth; pass { auth: { apiKey } } per call', {
      kind: 'invalid_auth',
      retryable: false,
    })
  }
  return auth
}

export function createClient(config: ClientConfig): Client {
  const { adapters, pricing } = config
  const sink = config.sink
  const clock: Clock = config.clock ?? DEFAULT_CLOCK
  const ids: IdGenerator = config.ids ?? DEFAULT_IDS
  const logger: Logger = config.logger ?? NOOP_LOGGER
  const telemetry: Telemetry = config.telemetry ?? NOOP_TELEMETRY
  const rateLimiter: RateLimiter = config.rateLimiter ?? NOOP_RATE_LIMITER
  const libDefaults: GenConfig = config.defaults ?? {}
  const registry: ModelRegistry = config.modelRegistry ?? defaultGeminiRegistry

  // Build O(1) adapter map at construction time — also detects duplicate ids.
  const adapterMap = new Map<string, ProviderAdapter>()
  for (const a of adapters) {
    if (adapterMap.has(a.id)) {
      throw new LlmError(`Duplicate adapter id "${a.id}"`, {
        kind: 'bad_request',
        retryable: false,
      })
    }
    adapterMap.set(a.id, a)
  }

  // Validate middleware IDs are unique.
  if (config.middleware !== undefined && config.middleware.length > 0) {
    const seenIds = new Set<string>()
    for (const mw of config.middleware) {
      if (seenIds.has(mw.id)) {
        throw new LlmError(`Duplicate middleware id "${mw.id}"`, {
          kind: 'bad_request',
          retryable: false,
        })
      }
      seenIds.add(mw.id)
    }
  }

  const routeFn =
    config.route ??
    ((model: string, adpts: ProviderAdapter[]) =>
      defaultRoute(model, adpts, adapterMap, registry))

  // -------------------------------------------------------------------------
  // Core pipeline (shared by generate + runStructured)
  // -------------------------------------------------------------------------
  //
  // Receives a fully-rendered request plus a pre-merged resolved config so the
  // caller (generate / runStructured) owns config-resolution semantics.
  //
  // Error path guarantee (postmortems on failure — SPEC goal 3):
  //   Any throw → classify → build record (with whatever usage is known) →
  //   sink.record (fail-open) → telemetry.onError (fail-open) → rethrow.
  //   The record is ALWAYS attempted, even when the adapter was never reached.
  // -------------------------------------------------------------------------

  async function runPipeline<S extends StandardSchemaV1>(
    request: LlmRequest<S>,
    resolvedConfig: ResolvedConfig,
    callSiteId: string | undefined,
    callerSignal: AbortSignal | undefined,
    callAuth: AuthMaterial,
  ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>> {
    // ── (a) Call-level prologue ────────────────────────────────────────────
    // ONE callId per logical call.  ONE onStart.  ONE log-start entry.
    // These fire before the middleware chain runs (including any retry logic).
    const callStartMs = clock.now()
    const callId = ids.callId()

    // lastAttemptId is assigned ONLY when runAttempt actually begins.
    // It stays undefined if a middleware throws before next() is called.
    let lastAttemptId: string | undefined

    let span: unknown
    try {
      const startEvent: CallStartEvent = {
        callId,
        model: request.model,
        metadata: request.metadata ?? {},
        ...(callSiteId !== undefined ? { callSiteId } : {}),
      }
      span = telemetry.onStart?.(startEvent)
    } catch { /* telemetry failures are always swallowed */ }

    logger.info({ callId, model: request.model, callSiteId, metadata: request.metadata ?? {} }, 'llm.call.start')

    // Build the pre-resolved request for the middleware chain.
    // The per-attempt signal is NOT included here — each attempt builds its
    // own combined (caller + timeout) signal inside runAttempt.
    const descriptor = registry.resolve(request.model)
    const preResolvedReq: ResolvedRequest = {
      model: request.model,
      messages: request.messages,
      config: resolvedConfig,
      ...(request.system !== undefined ? { system: request.system } : {}),
      ...(request.output?.schema !== undefined
        ? { outputSchema: request.output.schema }
        : {}),
      ...(descriptor !== undefined ? { modelDescriptor: descriptor } : {}),
    }

    // EngineCtx carries stable call-level state.  ctx.signal is the raw
    // caller signal (no timeout component) — the timeout is added per-attempt.
    const engineCtx: EngineCtx = {
      callId,
      clock,
      logger,
      ...(callerSignal !== undefined ? { signal: callerSignal } : {}),
    }

    // ── (b) runAttempt — the innermost Handler ─────────────────────────────
    //
    // Generates a FRESH attemptId on every invocation.
    // Does: route → auth → acquire → adapter.run → normalize → validate →
    //        cost → buildRecord → sink → return.
    // The cancellation race and rate-limiter acquire/release live here so
    // each retry gets its own independent timeout window.
    //
    // Errors: classify → build error record → sink (fail-open) → rethrow.
    // The call-level telemetry.onError and logger.error are fired by the
    // epilogue after the chain settles, NOT here.
    async function runAttempt(req: ResolvedRequest, ctx: EngineCtx): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>> {
      const attemptStartMs = ctx.clock.now()
      // Generate a fresh attemptId on every invocation.
      // Assign to lastAttemptId so the call-level epilogue can reference it.
      const attemptId = ids.attemptId()
      lastAttemptId = attemptId

      // Track progressive state for the error-path record builder.
      let provider = deriveProvider(req.model, registry)
      let normalizedResult: { usage: Usage; warnings: Warning[] } | undefined
      let cost: Cost | undefined
      // Release function returned by rateLimiter.acquire — called on every exit path.
      let release: Release | undefined
      // Cancellation cleanup — idempotent; safe to call on both paths.
      let cleanup: () => void = () => {}

      try {
        // Step 4b: Per-model config validation — runs BEFORE auth/rate-limiter/adapter.
        // Validates a projection of resolvedConfig that excludes execution-spine
        // fields (timeoutMs, providerOptions), keeping only the generation knobs
        // that belong to the model's schema.
        if (req.modelDescriptor?.validateConfig !== undefined) {
          const { temperature, topP, topK, maxOutputTokens, stopSequences, reasoning, serviceTier } =
            req.config
          const projection: Record<string, unknown> = { serviceTier }
          if (temperature !== undefined) projection['temperature'] = temperature
          if (topP !== undefined) projection['topP'] = topP
          if (topK !== undefined) projection['topK'] = topK
          if (maxOutputTokens !== undefined) projection['maxOutputTokens'] = maxOutputTokens
          if (stopSequences !== undefined) projection['stopSequences'] = stopSequences
          if (reasoning !== undefined) projection['reasoning'] = reasoning

          const syncOrAsync = req.modelDescriptor.validateConfig['~standard'].validate(projection)
          const validationResult =
            syncOrAsync instanceof Promise ? await syncOrAsync : syncOrAsync

          if (validationResult.issues !== undefined) {
            const message = validationResult.issues.map((i) => i.message).join('; ')
            throw new LlmError(`Model config validation failed: ${message}`, {
              kind: 'bad_request',
              retryable: false,
            })
          }
        }

        // Step 5: Resolve adapter (may throw LlmError 'bad_request')
        const adapter = routeFn(req.model, adapters)
        provider = adapter.id

        // ── Per-attempt cancellation setup ──────────────────────────────────
        // adapter.run() is raced against two independent rejection promises:
        //
        //   (a) Caller-abort  — rejects LlmError('aborted') when ctx.signal fires.
        //   (b) Timeout       — rejects LlmError('timeout') when the timer fires.
        //
        // Each attempt gets its own timeout window (independent of how long
        // prior attempts / retry backoffs took).
        //
        // Invariant A (timeout-beats-abort microtask ordering): the timeout
        // promise rejects BEFORE its AbortController is fired — guaranteed by
        // buildCancellationRace.  Do not reorder.
        const cancellation = buildCancellationRace(ctx.signal, req.attemptTimeoutMs ?? req.config.timeoutMs)
        cleanup = cancellation.cleanup
        const { raceParts, combinedSignal } = cancellation

        // Step 6b: Rate-limiter acquire — PRE-SEND backpressure.
        const acquirePromise = rateLimiter.acquire(`${provider}:${req.model}`, combinedSignal)
        release =
          raceParts.length > 0
            ? await Promise.race([acquirePromise, ...raceParts])
            : await acquirePromise

        // Step 6c: Build adapter-specific request (with the combined signal)
        // and the AdapterCtx.
        const adapterReq: ResolvedRequest = combinedSignal !== undefined
          ? { ...req, signal: combinedSignal }
          : req

        const adapterCtx: AdapterCtx = {
          auth: callAuth,
          logger: ctx.logger,
          ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
        }

        // Step 7: Run adapter — raced against all cancellation promises.
        const runPromise = adapter.run(adapterReq, adapterCtx)
        const adapterResult =
          raceParts.length > 0
            ? await Promise.race([runPromise, ...raceParts])
            : await runPromise

        // Cleanup on success path (idempotent).
        cleanup()
        // Release the rate-limiter slot — swallow errors so a broken Release
        // cannot mask the successful result.
        try { release?.() } catch { /* intentionally swallowed */ }
        release = undefined

        // Step 7b: Normalize usage ONCE.
        normalizedResult = normalizeUsage(adapterResult.usage)

        // Step 8: Validate structured output (terminal on failure).
        let output: StandardSchemaV1.InferOutput<S> | undefined
        if (req.outputSchema !== undefined) {
          const schema = req.outputSchema
          // Standard Schema: validate() may return sync or async — await handles both.
          const validateResult = await schema['~standard'].validate(adapterResult.rawStructured)
          if (validateResult.issues !== undefined) {
            const message = validateResult.issues
              .map((issue) => issue.message)
              .join('; ')
            throw new LlmError(
              `Structured output validation failed: ${message}`,
              { kind: 'parse_error', retryable: false, cause: validateResult.issues },
            )
          }
          output = validateResult.value as StandardSchemaV1.InferOutput<S>
        }

        // Step 9: Cost — fail-open (never fail the call for costing).
        const costWarnings: Warning[] = []
        try {
          const pricingKey = req.modelDescriptor?.pricingFamily ?? req.model
          cost = pricing.price(pricingKey, normalizedResult.usage, resolvedConfig.serviceTier)
        } catch (costErr) {
          costWarnings.push({
            type: 'other',
            message: `Cost computation failed: ${String(costErr)}`,
          })
          ctx.logger.warn({ callId: ctx.callId, error: String(costErr) }, 'llm.call.cost.failed')
        }

        // Collect all warnings (adapter + normalize + cost).
        const allWarnings: Warning[] = [
          ...adapterResult.warnings,
          ...normalizedResult.warnings,
          ...costWarnings,
        ]

        // Step 10: Build LlmCallRecord.
        const latencyMs = ctx.clock.now() - attemptStartMs
        const record = buildSuccessRecord(
          ctx.callId,
          attemptId,
          callSiteId,
          provider,
          req.model,
          request.metadata,
          resolvedConfig,
          adapterResult,
          normalizedResult.usage,
          cost,
          allWarnings,
          latencyMs,
          attemptStartMs,
        )

        // Step 11: Sink — fail-open.
        await recordToSink(sink, record, ctx.logger, ctx.callId)

        // Step 12: Return LlmResult.
        const result: LlmResult<StandardSchemaV1.InferOutput<S>> = {
          callId: ctx.callId,
          attemptId,
          usage: normalizedResult.usage,
          model: adapterResult.model,
          latencyMs,
          warnings: allWarnings,
          ...(output !== undefined ? { output } : {}),
          ...(adapterResult.text !== undefined ? { text: adapterResult.text } : {}),
          ...(adapterResult.reasoningText !== undefined
            ? { reasoningText: adapterResult.reasoningText }
            : {}),
          ...(cost !== undefined ? { cost } : {}),
          ...(adapterResult.modelVersion !== undefined
            ? { modelVersion: adapterResult.modelVersion }
            : {}),
          ...(adapterResult.finishReason !== undefined
            ? { finishReason: adapterResult.finishReason }
            : {}),
          ...(adapterResult.responseId !== undefined
            ? { responseId: adapterResult.responseId }
            : {}),
          ...(adapterResult.providerMetadata !== undefined
            ? { providerMetadata: adapterResult.providerMetadata }
            : {}),
        }
        return result

      } catch (rawErr) {
        // Invariant B: cleanup on every error path.
        cleanup()
        try { release?.() } catch { /* intentionally swallowed */ }
        release = undefined

        // Classify error (LlmError passes through unchanged).
        const err = classifyError(rawErr)

        // Build postmortem record with whatever we know.
        const latencyMs = ctx.clock.now() - attemptStartMs
        const errorRecord = buildErrorRecord(
          ctx.callId,
          attemptId,
          callSiteId,
          provider,
          req.model,
          request.metadata,
          resolvedConfig,
          normalizedResult?.usage ?? EMPTY_USAGE,
          latencyMs,
          attemptStartMs,
          err,
        )

        // Sink error record — fail-open.
        await recordToSink(sink, errorRecord, ctx.logger, ctx.callId)

        // Enrich the error with call context (idempotent — does not overwrite
        // if already set, e.g. by an outer middleware).
        attachCallContext(err, { callId: ctx.callId, attemptId })

        // Rethrow: the call-level epilogue (or retry middleware) handles
        // the final fate of this error.
        throw err
      }
    }

    // ── Compose the middleware chain ───────────────────────────────────────
    // middleware[0] is outermost; runAttempt is innermost (reduceRight folds
    // from right so index-0 wraps everything else).
    const middlewareList = config.middleware ?? []
    const chain: Handler = middlewareList.reduceRight(
      (next: Handler, mw: Middleware): Handler =>
        (req, ctx) => mw.intercept(req, ctx, next),
      runAttempt as Handler,
    )

    // ── (c) Execute the chain with call-level epilogue ─────────────────────
    // telemetry.onSuccess / onError and the call-level logger events fire
    // ONCE here, after the chain (including any retry middleware) settles.
    try {
      const result = await chain(preResolvedReq, engineCtx)
      const latencyMs = clock.now() - callStartMs
      try {
        const successEvent: CallSuccessEvent = {
          callId,
          attemptId: result.attemptId,
          model: request.model,
          metadata: request.metadata ?? {},
          latencyMs,
          usage: result.usage,
          ...(result.cost !== undefined ? { cost: result.cost } : {}),
          ...(callSiteId !== undefined ? { callSiteId } : {}),
        }
        telemetry.onSuccess?.(successEvent, span)
      } catch { /* swallowed */ }
      logger.info({ callId, latencyMs, metadata: request.metadata ?? {} }, 'llm.call.success')
      return result as LlmResult<StandardSchemaV1.InferOutput<S>>
    } catch (rawErr) {
      const err = classifyError(rawErr)
      // Ensure the error carries call context (idempotent — runAttempt already
      // calls attachCallContext, but middleware-thrown errors may not have it).
      // Only stamp attemptId when a real attempt ran (lastAttemptId is defined).
      attachCallContext(err, { callId, ...(lastAttemptId !== undefined ? { attemptId: lastAttemptId } : {}) })
      const latencyMs = clock.now() - callStartMs
      try {
        const attemptIdForEvent = err.attemptId ?? lastAttemptId
        const errorEvent: CallErrorEvent = {
          callId,
          model: request.model,
          metadata: request.metadata ?? {},
          latencyMs,
          errorKind: err.kind,
          retryable: err.retryable,
          ...(callSiteId !== undefined ? { callSiteId } : {}),
          ...(attemptIdForEvent !== undefined ? { attemptId: attemptIdForEvent } : {}),
        }
        telemetry.onError?.(errorEvent, span)
      } catch { /* swallowed */ }
      logger.error({ callId, errorKind: err.kind, latencyMs, metadata: request.metadata ?? {} }, 'llm.call.error')
      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  return {
    async generate<S extends StandardSchemaV1>(
      request: LlmRequest<S>,
      opts: GenerateOptions,
    ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>> {
      const callAuth = requireAuth(opts?.auth)
      // Config resolution: libDefaults → request.config
      const merged = deepMergeConfig(libDefaults, request.config)
      const serviceTier = merged.serviceTier ?? 'flex'
      const resolvedConfig: ResolvedConfig = {
        ...merged,
        serviceTier,
      }
      return runPipeline<S>(request, resolvedConfig, undefined, opts.signal, callAuth)
    },

    async runStructured<S extends StandardSchemaV1>(
      callSite: CallSite<S>,
      varsOrOpts: Record<string, string> | RunStructuredOptions,
      opts?: RunStructuredOptions,
    ): Promise<LlmResult<StandardSchemaV1.InferOutput<S>>> {
      // Detect overload: (callSite, opts) vs (callSite, vars, opts)
      let vars: Record<string, string>
      let resolvedOpts: RunStructuredOptions
      if (opts !== undefined) {
        // Three-arg form: (callSite, vars, opts)
        vars = varsOrOpts as Record<string, string>
        resolvedOpts = opts
      } else {
        // Two-arg form: (callSite, opts)
        vars = {}
        resolvedOpts = varsOrOpts as RunStructuredOptions
      }

      const callAuth = requireAuth(resolvedOpts?.auth)

      // Config resolution: libDefaults → callSite.config → opts.config
      const merged = deepMergeConfig(libDefaults, callSite.config, resolvedOpts.config)
      const serviceTier = merged.serviceTier ?? 'flex'
      const resolvedConfig: ResolvedConfig = {
        ...merged,
        serviceTier,
      }

      // Render templates (non-recursive interpolation; missing vars → placeholder).
      const userText =
        callSite.userTemplate !== undefined
          ? interpolate(callSite.userTemplate, vars)
          : ''
      const renderedSystem =
        callSite.system !== undefined
          ? interpolate(callSite.system, vars)
          : undefined

      // Build the rendered request (no config on the request — already merged).
      const request: LlmRequest<S> = {
        model: callSite.model,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: userText }] }],
        ...(renderedSystem !== undefined ? { system: renderedSystem } : {}),
        ...(callSite.schema !== undefined
          ? { output: { schema: callSite.schema } }
          : {}),
        ...(resolvedOpts.metadata !== undefined ? { metadata: resolvedOpts.metadata } : {}),
      }

      return runPipeline<S>(request, resolvedConfig, callSite.id, resolvedOpts.signal, callAuth)
    },
  }
}
