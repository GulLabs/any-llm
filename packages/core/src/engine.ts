/**
 * Engine for @anyllm/core — the heart of the library.
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
import type { ZodType } from 'zod'
import { LlmError, classifyError } from './errors.js'
import { buildRecord, normalizeUsage } from './record.js'
import type {
  ProviderAdapter,
  AuthProvider,
  PricingSource,
  UsageSink,
  Clock,
  IdGenerator,
  Logger,
  Telemetry,
  ResolvedRequest,
  AdapterCtx,
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
  /** Resolves credentials for each provider at call time. */
  auth: AuthProvider
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
}

/**
 * Options accepted by {@link Client.generate}.
 */
export interface GenerateOptions {
  /** Caller-supplied abort signal. Classifies as `'aborted'` when fired. */
  signal?: AbortSignal
}

/**
 * Options accepted by {@link Client.runStructured}.
 */
export interface RunStructuredOptions {
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
   *
   * @returns A typed {@link LlmResult} on success; throws {@link LlmError} on failure.
   */
  generate<S extends ZodType>(
    request: LlmRequest<S>,
    opts?: GenerateOptions,
  ): Promise<LlmResult<S['_output']>>

  /**
   * Execute an LLM call described by a {@link CallSite} with optional
   * template variables and per-call overrides.
   *
   * Config resolution: `clientDefaults → callSite.config → opts.config`.
   * Template interpolation: `{{var}}` in `system` and `userTemplate` is
   * replaced with the corresponding value from `vars`.  Var values are NOT
   * themselves interpolated (anti-injection).  Missing vars are left as the
   * literal `{{var}}` placeholder.
   *
   * @returns A typed {@link LlmResult} with `output` typed to the call-site schema.
   */
  runStructured<S extends ZodType>(
    callSite: CallSite<S>,
    vars?: Record<string, string>,
    opts?: RunStructuredOptions,
  ): Promise<LlmResult<S['_output']>>
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
 * Deep-merges {@link GenConfig} objects left-to-right (later entries win).
 *
 * Scalar fields (`temperature`, `topP`, etc.) use last-write-wins.
 * Object fields (`reasoning`, `providerOptions`) are shallowly merged so a
 * per-call override can set individual sub-keys without replacing the entire
 * object.
 */
function deepMergeConfig(...configs: Array<GenConfig | undefined>): GenConfig {
  const acc: Record<string, unknown> = {}
  for (const cfg of configs) {
    if (cfg === undefined) continue
    const keys = Object.keys(cfg) as Array<keyof GenConfig>
    for (const key of keys) {
      const val = cfg[key]
      if (val === undefined) continue
      if (key === 'reasoning' && typeof val === 'object' && val !== null) {
        acc[key] = { ...(acc[key] as object | undefined ?? {}), ...val }
      } else if (key === 'providerOptions' && typeof val === 'object' && val !== null) {
        acc[key] = { ...(acc[key] as Record<string, unknown> | undefined ?? {}), ...val }
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
 */
function mergeSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason)
      return controller.signal
    }
    sig.addEventListener(
      'abort',
      () => { controller.abort(sig.reason) },
      { once: true },
    )
  }
  return controller.signal
}

/**
 * Derives the provider identifier from a model string for routing and records.
 *
 * | Model prefix   | Provider   |
 * |----------------|------------|
 * | `gemini-*`     | `'google'` |
 * | `provider/…`   | `provider` |
 * | (other)        | `'unknown'`|
 */
function deriveProvider(model: string): string {
  if (model.startsWith('gemini')) return 'google'
  const slash = model.indexOf('/')
  if (slash > 0) return model.slice(0, slash)
  return 'unknown'
}

/**
 * Default router: use the single adapter when only one is configured; otherwise
 * match by derived provider from the model string.
 *
 * @throws {@link LlmError} `'bad_request'` when no matching adapter is found.
 */
function defaultRoute(model: string, adapters: ProviderAdapter[]): ProviderAdapter {
  if (adapters.length === 0) {
    throw new LlmError('No adapters configured', {
      kind: 'bad_request',
      retryable: false,
    })
  }
  if (adapters.length === 1) {
    return adapters[0]!
  }
  const provider = deriveProvider(model)
  const found = adapters.find((a) => a.id === provider)
  if (found === undefined) {
    throw new LlmError(
      `No adapter found for model "${model}" (derived provider: "${provider}")`,
      { kind: 'bad_request', retryable: false },
    )
  }
  return found
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
 *   auth: envAuth(),
 *   pricing: geminiPricingSource(),
 *   sink: drizzleUsageSink(db, llmCallsTable),
 * })
 *
 * const result = await client.generate({
 *   model: 'gemini-2.5-pro',
 *   messages: [{ role: 'user', parts: [{ kind: 'text', text: 'Hello!' }] }],
 * })
 * ```
 */
export function createClient(config: ClientConfig): Client {
  const { adapters, auth, pricing } = config
  const sink = config.sink
  const clock: Clock = config.clock ?? DEFAULT_CLOCK
  const ids: IdGenerator = config.ids ?? DEFAULT_IDS
  const logger: Logger = config.logger ?? NOOP_LOGGER
  const telemetry: Telemetry = config.telemetry ?? NOOP_TELEMETRY
  const libDefaults: GenConfig = config.defaults ?? {}
  const routeFn = config.route ?? defaultRoute

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

  async function runPipeline<S extends ZodType>(
    request: LlmRequest<S>,
    resolvedConfig: Required<Pick<GenConfig, 'serviceTier'>> & GenConfig,
    callSiteId: string | undefined,
    callerSignal: AbortSignal | undefined,
  ): Promise<LlmResult<S['_output']>> {
    const startMs = clock.now()

    // Step 3: IDs
    const callId = ids.callId()
    const attemptId = ids.attemptId()

    // Step 4: telemetry.onStart + logger
    let span: unknown
    try {
      span = telemetry.onStart?.({
        callId,
        attemptId,
        model: request.model,
        callSiteId,
      })
    } catch { /* telemetry failures are always swallowed */ }

    logger.info(
      { callId, attemptId, model: request.model, callSiteId },
      'llm.call.start',
    )

    // Track progressive state for the error-path record builder.
    let provider = deriveProvider(request.model)
    let normalizedResult: { usage: Usage; warnings: Warning[] } | undefined
    let cost: Cost | undefined
    let timer: ReturnType<typeof setTimeout> | undefined

    try {
      // Step 5: Resolve adapter (may throw LlmError 'bad_request')
      const adapter = routeFn(request.model, adapters)
      provider = adapter.id

      // Step 6: Auth
      const authMaterial = await auth.credentials(provider)

      // Build combined AbortSignal (caller + timeout).
      const signalParts: AbortSignal[] = []
      if (callerSignal !== undefined) signalParts.push(callerSignal)

      let timeoutRejectFn: ((err: LlmError) => void) | undefined
      let timeoutPromise: Promise<never> | undefined

      if (resolvedConfig.timeoutMs !== undefined) {
        const timeoutController = new AbortController()
        signalParts.push(timeoutController.signal)
        const ms = resolvedConfig.timeoutMs
        timeoutPromise = new Promise<never>((_, reject) => {
          timeoutRejectFn = reject
          timer = setTimeout(() => {
            timeoutController.abort()
            reject(
              new LlmError(`Request timed out after ${ms}ms`, {
                kind: 'timeout',
                retryable: true,
              }),
            )
          }, ms)
        })
      }

      const combinedSignal: AbortSignal | undefined =
        signalParts.length === 0
          ? undefined
          : signalParts.length === 1
            ? signalParts[0]
            : mergeSignals(signalParts)

      // Step 6b: Build ResolvedRequest
      const resolved: ResolvedRequest = {
        model: request.model,
        messages: request.messages,
        config: resolvedConfig,
        ...(request.system !== undefined ? { system: request.system } : {}),
        ...(request.output?.schema !== undefined
          ? { outputSchema: request.output.schema }
          : {}),
        ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
      }

      const ctx: AdapterCtx = {
        auth: authMaterial,
        logger,
        ...(combinedSignal !== undefined ? { signal: combinedSignal } : {}),
      }

      // Step 7: adapter.run — raced against timeout promise when present.
      const runPromise = adapter.run(resolved, ctx)
      const adapterResult =
        timeoutPromise !== undefined
          ? await Promise.race([runPromise, timeoutPromise])
          : await runPromise

      // Clear timeout timer on success path.
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      // Suppress unused-variable warning; timeoutRejectFn is only used by the
      // timer callback and Promise.race handles cancellation.
      void timeoutRejectFn

      // Step 7b: Normalize usage ONCE.
      normalizedResult = normalizeUsage(adapterResult.usage)

      // Step 8: Validate structured output (terminal on failure).
      let output: S['_output'] | undefined
      if (request.output?.schema !== undefined) {
        const parseResult = request.output.schema.safeParse(adapterResult.rawStructured)
        if (!parseResult.success) {
          throw new LlmError(
            `Structured output validation failed: ${parseResult.error.message}`,
            { kind: 'parse_error', retryable: false, cause: parseResult.error },
          )
        }
        output = parseResult.data as S['_output']
      }

      // Step 9: Cost — fail-open (never fail the call for costing).
      const costWarnings: Warning[] = []
      try {
        cost = pricing.price(
          request.model,
          normalizedResult.usage,
          resolvedConfig.serviceTier,
        )
      } catch (costErr) {
        costWarnings.push({
          type: 'other',
          message: `Cost computation failed: ${String(costErr)}`,
        })
        logger.warn({ callId, error: String(costErr) }, 'llm.call.cost.failed')
      }

      // Collect all warnings (adapter + normalize + cost).
      const allWarnings: Warning[] = [
        ...adapterResult.warnings,
        ...normalizedResult.warnings,
        ...costWarnings,
      ]

      // Step 10: Build LlmCallRecord.
      const latencyMs = clock.now() - startMs
      const record = buildRecord({
        callId,
        attemptId,
        ...(callSiteId !== undefined ? { callSiteId } : {}),
        provider,
        model: request.model,
        ...(adapterResult.modelVersion !== undefined
          ? { modelVersion: adapterResult.modelVersion }
          : {}),
        ...(adapterResult.responseId !== undefined
          ? { responseId: adapterResult.responseId }
          : {}),
        serviceTier: resolvedConfig.serviceTier,
        usage: normalizedResult.usage,
        ...(cost !== undefined ? { cost } : {}),
        latencyMs,
        status: 'ok',
        ...(adapterResult.finishReason !== undefined
          ? { finishReason: adapterResult.finishReason }
          : {}),
        warnings: allWarnings,
        generationConfig: resolvedConfig,
        metadata: request.metadata ?? {},
        createdAt: new Date(startMs).toISOString(),
        ...(adapterResult.reasoningText !== undefined
          ? { reasoningText: adapterResult.reasoningText }
          : {}),
        ...(adapterResult.providerMetadata !== undefined
          ? { providerMetadata: adapterResult.providerMetadata }
          : {}),
      })

      // Step 11: Sink — fail-open.
      if (sink !== undefined) {
        try {
          await sink.record(record)
        } catch (sinkErr) {
          logger.error({ callId, error: String(sinkErr) }, 'llm.call.sink.failed')
        }
      }

      // Step 12: telemetry.onSuccess + logger.
      try {
        telemetry.onSuccess?.({ callId, latencyMs, model: request.model }, span)
      } catch { /* swallowed */ }
      logger.info({ callId, latencyMs }, 'llm.call.success')

      // Step 13: Return LlmResult.
      const result: LlmResult<S['_output']> = {
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
      // Always clear the timer on any exit path.
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }

      // Classify error (LlmError passes through unchanged).
      const err = classifyError(rawErr)

      // Build postmortem record with whatever we know.
      const latencyMs = clock.now() - startMs
      const errorUsage = normalizedResult?.usage ?? EMPTY_USAGE
      const errorRecord = buildRecord({
        callId,
        attemptId,
        ...(callSiteId !== undefined ? { callSiteId } : {}),
        provider,
        model: request.model,
        usage: errorUsage,
        latencyMs,
        // buildRecord overrides status from error.kind via errorKindToStatus.
        status: 'api_error',
        generationConfig: resolvedConfig,
        metadata: request.metadata ?? {},
        createdAt: new Date(startMs).toISOString(),
        error: err,
      })

      // Sink error record — fail-open.
      if (sink !== undefined) {
        try {
          await sink.record(errorRecord)
        } catch (sinkErr) {
          logger.error({ callId, error: String(sinkErr) }, 'llm.call.sink.failed')
        }
      }

      // Telemetry + logger — fail-open.
      try {
        telemetry.onError?.(
          { callId, errorKind: err.kind, latencyMs, model: request.model },
          span,
        )
      } catch { /* swallowed */ }
      logger.error({ callId, errorKind: err.kind, latencyMs }, 'llm.call.error')

      throw err
    }
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  return {
    async generate<S extends ZodType>(
      request: LlmRequest<S>,
      opts?: GenerateOptions,
    ): Promise<LlmResult<S['_output']>> {
      // Config resolution: libDefaults → request.config
      const merged = deepMergeConfig(libDefaults, request.config)
      const serviceTier = merged.serviceTier ?? 'flex'
      const resolvedConfig: Required<Pick<GenConfig, 'serviceTier'>> & GenConfig = {
        ...merged,
        serviceTier,
      }
      return runPipeline<S>(request, resolvedConfig, undefined, opts?.signal)
    },

    async runStructured<S extends ZodType>(
      callSite: CallSite<S>,
      vars?: Record<string, string>,
      opts?: RunStructuredOptions,
    ): Promise<LlmResult<S['_output']>> {
      // Config resolution: libDefaults → callSite.config → opts.config
      const merged = deepMergeConfig(libDefaults, callSite.config, opts?.config)
      const serviceTier = merged.serviceTier ?? 'flex'
      const resolvedConfig: Required<Pick<GenConfig, 'serviceTier'>> & GenConfig = {
        ...merged,
        serviceTier,
      }

      // Render templates (non-recursive interpolation; missing vars → placeholder).
      const resolvedVars: Record<string, string> = vars ?? {}
      const userText =
        callSite.userTemplate !== undefined
          ? interpolate(callSite.userTemplate, resolvedVars)
          : ''
      const renderedSystem =
        callSite.system !== undefined
          ? interpolate(callSite.system, resolvedVars)
          : undefined

      // Build the rendered request (no config on the request — already merged).
      const request: LlmRequest<S> = {
        model: callSite.model,
        messages: [{ role: 'user', parts: [{ kind: 'text', text: userText }] }],
        ...(renderedSystem !== undefined ? { system: renderedSystem } : {}),
        ...(callSite.schema !== undefined
          ? { output: { schema: callSite.schema } }
          : {}),
        ...(opts?.metadata !== undefined ? { metadata: opts.metadata } : {}),
      }

      return runPipeline<S>(request, resolvedConfig, callSite.id, opts?.signal)
    },
  }
}
