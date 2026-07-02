import { LlmError, type Middleware, type RateLimiter, type Release } from '@gullabs/core'

export type QuotaDeferReason = 'rpm_exhausted' | 'rpd_exhausted'
export type QuotaDenyReason = 'provider_disabled'

export type QuotaDecision =
  | { kind: 'allow' }
  | { kind: 'defer'; retryAfterMs: number; scope: string; reason: QuotaDeferReason }
  | { kind: 'deny'; scope: string; reason: QuotaDenyReason }

export type QuotaEvent =
  | {
      type: 'allow'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'allow' }>
    }
  | {
      type: 'defer'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'defer' }>
    }
  | {
      type: 'deny'
      provider: string
      model: string
      scope: string
      decision: Extract<QuotaDecision, { kind: 'deny' }>
    }
  | {
      type: 'backend_error'
      provider: string
      model: string
      scope: string
      error: unknown
    }

export type QuotaEventHandler = (event: QuotaEvent) => void

export interface QuotaPolicyInput {
  provider: string
  model: string
}

export interface ProviderQuotaRule {
  scope?: string
  rpm?: number
  rpd?: number
}

export interface ProviderQuotaPolicy {
  getRule(input: QuotaPolicyInput): ProviderQuotaRule | undefined
}

export interface QuotaStoreWindowResult {
  allowed: boolean
  retryAfterMs?: number
  remaining?: number
  used?: number
}

export interface QuotaStoreCheckInput {
  scope: string
  nowMs: number
  rpm?: number
  rpd?: number
  signal?: AbortSignal
}

export interface QuotaStoreCheckResult {
  rpm?: QuotaStoreWindowResult
  rpd?: QuotaStoreWindowResult
}

export interface QuotaStore {
  checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult>
}

export interface CheckProviderQuotaOptions {
  provider: string
  model: string
  policy: ProviderQuotaPolicy
  store: QuotaStore
  nowMs?: number
  signal?: AbortSignal
}

export interface EnforceProviderQuotaOptions extends CheckProviderQuotaOptions {
  onEvent?: QuotaEventHandler
}

export interface ProviderQuotaMiddlewareOptions {
  id?: string
  provider: string
  policy: ProviderQuotaPolicy
  store: QuotaStore
  onEvent?: QuotaEventHandler
  now?: () => number
}

export interface ProviderQuotaRateLimiterOptions {
  policy: ProviderQuotaPolicy
  store: QuotaStore
  onEvent?: QuotaEventHandler
  now?: () => number
}

export interface GeminiQuotaLimits {
  rpm?: number
  rpd?: number
}

export interface GeminiQuotaPolicyOptions {
  provider?: string
  models: Record<string, GeminiQuotaLimits>
  defaultLimits?: GeminiQuotaLimits
  scope?: (input: QuotaPolicyInput) => string
}

export type UpstashPipelineCommand = readonly [string, ...Array<string | number>]
export type UpstashPipelineInvoker = (
  commands: readonly UpstashPipelineCommand[],
  signal?: AbortSignal,
) => Promise<readonly unknown[]>

export interface UpstashQuotaStoreOptions {
  prefix?: string
  invoke?: UpstashPipelineInvoker
  url?: string
  token?: string
  fetch?: typeof globalThis.fetch
}

interface ResolvedQuotaRule {
  configured: boolean
  scope: string
  rpm?: number
  rpd?: number
}

const NOOP_RELEASE: Release = () => {}

export function quotaPolicyForGemini(
  opts: GeminiQuotaPolicyOptions,
): ProviderQuotaPolicy {
  const provider = opts.provider ?? 'google'

  return {
    getRule(input: QuotaPolicyInput): ProviderQuotaRule | undefined {
      if (input.provider !== provider) return undefined

      const limits = opts.models[input.model] ?? opts.defaultLimits
      if (limits === undefined) return undefined

      const rule: ProviderQuotaRule = {
        scope: opts.scope?.(input) ?? defaultScope(input.provider, input.model),
      }

      if (limits.rpm !== undefined) {
        rule.rpm = limits.rpm
      }
      if (limits.rpd !== undefined) {
        rule.rpd = limits.rpd
      }

      return rule
    },
  }
}

export async function checkProviderQuota(
  opts: CheckProviderQuotaOptions,
): Promise<QuotaDecision> {
  const nowMs = opts.nowMs ?? Date.now()
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model)
  return evaluateQuotaDecision(resolved, opts.store, nowMs, opts.signal)
}

export async function enforceProviderQuota(
  opts: EnforceProviderQuotaOptions,
): Promise<void> {
  const nowMs = opts.nowMs ?? Date.now()
  const resolved = resolveQuotaRule(opts.policy, opts.provider, opts.model)

  try {
    const decision = await evaluateQuotaDecision(resolved, opts.store, nowMs, opts.signal)

    switch (decision.kind) {
      case 'allow':
        emitEvent(opts.onEvent, {
          type: 'allow',
          provider: opts.provider,
          model: opts.model,
          scope: resolved.scope,
          decision,
        })
        return

      case 'defer':
        emitEvent(opts.onEvent, {
          type: 'defer',
          provider: opts.provider,
          model: opts.model,
          scope: resolved.scope,
          decision,
        })
        throw new LlmError(
          messageForDefer(decision.reason, decision.scope, decision.retryAfterMs),
          {
            kind: 'rate_limited',
            retryable: true,
            retryAfterMs: decision.retryAfterMs,
          },
        )

      case 'deny':
        emitEvent(opts.onEvent, {
          type: 'deny',
          provider: opts.provider,
          model: opts.model,
          scope: resolved.scope,
          decision,
        })
        {
          const error = new LlmError(messageForDeny(decision.reason, decision.scope), {
            kind: 'rate_limited',
            retryable: false,
          })
          // LlmError declares `retryAfterMs` as a class field, so with
          // useDefineForClassFields (implied by tsconfig's ES2022 target) every
          // instance gets an own `retryAfterMs` property initialized to
          // `undefined` — even though it's never passed in `options` here. This
          // delete keeps `'retryAfterMs' in error` false for non-retryable
          // deny errors, matching the `defer` case where it's genuinely absent.
          delete (error as { retryAfterMs?: number }).retryAfterMs
          throw error
        }

      default: {
        const exhaustive: never = decision
        return exhaustive
      }
    }
  } catch (error) {
    if (error instanceof LlmError && error.kind === 'rate_limited') {
      throw error
    }

    emitEvent(opts.onEvent, {
      type: 'backend_error',
      provider: opts.provider,
      model: opts.model,
      scope: resolved.scope,
      error,
    })
    throw error
  }
}

export function providerQuotaMiddleware(
  opts: ProviderQuotaMiddlewareOptions,
): Middleware {
  return {
    id: opts.id ?? `provider-quota:${opts.provider}`,
    async intercept(req, ctx, next) {
      const enforceOptions: EnforceProviderQuotaOptions = {
        provider: opts.provider,
        model: req.model,
        policy: opts.policy,
        store: opts.store,
        nowMs: opts.now?.() ?? ctx.clock.now(),
      }

      if (opts.onEvent !== undefined) {
        enforceOptions.onEvent = opts.onEvent
      }
      if (ctx.signal !== undefined) {
        enforceOptions.signal = ctx.signal
      }

      await enforceProviderQuota(enforceOptions)

      return next(req, ctx)
    },
  }
}

export function providerQuotaRateLimiter(
  opts: ProviderQuotaRateLimiterOptions,
): RateLimiter {
  return {
    async acquire(key: string, signal?: AbortSignal): Promise<Release> {
      const { provider, model } = parseRateLimiterKey(key)

      const enforceOptions: EnforceProviderQuotaOptions = {
        provider,
        model,
        policy: opts.policy,
        store: opts.store,
        nowMs: opts.now?.() ?? Date.now(),
      }

      if (opts.onEvent !== undefined) {
        enforceOptions.onEvent = opts.onEvent
      }
      if (signal !== undefined) {
        enforceOptions.signal = signal
      }

      await enforceProviderQuota(enforceOptions)

      return NOOP_RELEASE
    },
  }
}

export function upstashQuotaStore(opts: UpstashQuotaStoreOptions): QuotaStore {
  const prefix = opts.prefix ?? 'gullabs:quota'
  const invoke = opts.invoke ?? buildUpstashInvoker(opts)

  return {
    async checkAndConsume(input: QuotaStoreCheckInput): Promise<QuotaStoreCheckResult> {
      const commands: UpstashPipelineCommand[] = []
      const windows: Array<{ kind: 'rpm' | 'rpd'; limit: number; retryAfterMs: number }> =
        []

      if (input.rpm !== undefined && input.rpm > 0) {
        const retryAfterMs = timeUntilNextMinute(input.nowMs)
        commands.push(['INCR', bucketKey(prefix, input.scope, 'rpm', input.nowMs)])
        commands.push([
          'PEXPIRE',
          bucketKey(prefix, input.scope, 'rpm', input.nowMs),
          retryAfterMs,
        ])
        windows.push({ kind: 'rpm', limit: input.rpm, retryAfterMs })
      }

      if (input.rpd !== undefined && input.rpd > 0) {
        const retryAfterMs = timeUntilNextUtcDay(input.nowMs)
        commands.push(['INCR', bucketKey(prefix, input.scope, 'rpd', input.nowMs)])
        commands.push([
          'PEXPIRE',
          bucketKey(prefix, input.scope, 'rpd', input.nowMs),
          retryAfterMs,
        ])
        windows.push({ kind: 'rpd', limit: input.rpd, retryAfterMs })
      }

      if (commands.length === 0) {
        return {}
      }

      const rawResults = await invoke(commands, input.signal)
      const decision: QuotaStoreCheckResult = {}

      for (const [i, window] of windows.entries()) {
        const count = numericPipelineResult(rawResults[i * 2])
        const remaining = Math.max(window.limit - count, 0)
        const result: QuotaStoreWindowResult = {
          allowed: count <= window.limit,
          remaining,
          used: count,
        }

        if (!result.allowed) {
          result.retryAfterMs = window.retryAfterMs
        }

        if (window.kind === 'rpm') {
          decision.rpm = result
        } else {
          decision.rpd = result
        }
      }

      return decision
    },
  }
}

function resolveQuotaRule(
  policy: ProviderQuotaPolicy,
  provider: string,
  model: string,
): ResolvedQuotaRule {
  const rule = policy.getRule({ provider, model })
  const scope = rule?.scope ?? defaultScope(provider, model)
  const resolved: ResolvedQuotaRule = {
    configured: rule !== undefined,
    scope,
  }

  if (rule?.rpm !== undefined) {
    const rpm = validateConfiguredLimit('rpm', rule.rpm)
    if (rpm !== undefined) {
      resolved.rpm = rpm
    }
  }
  if (rule?.rpd !== undefined) {
    const rpd = validateConfiguredLimit('rpd', rule.rpd)
    if (rpd !== undefined) {
      resolved.rpd = rpd
    }
  }

  return resolved
}

async function evaluateQuotaDecision(
  resolved: ResolvedQuotaRule,
  store: QuotaStore,
  nowMs: number,
  signal?: AbortSignal,
): Promise<QuotaDecision> {
  if (!resolved.configured) {
    return { kind: 'allow' }
  }

  if (resolved.rpd === 0) {
    return {
      kind: 'deny',
      scope: resolved.scope,
      reason: 'provider_disabled',
    }
  }

  const rpm = normalizeConfiguredLimit(resolved.rpm)
  const rpd = normalizeConfiguredLimit(resolved.rpd)
  if (rpm === undefined && rpd === undefined) {
    return { kind: 'allow' }
  }

  const storeInput: QuotaStoreCheckInput = {
    scope: resolved.scope,
    nowMs,
  }
  if (rpm !== undefined) {
    storeInput.rpm = rpm
  }
  if (rpd !== undefined) {
    storeInput.rpd = rpd
  }
  if (signal !== undefined) {
    storeInput.signal = signal
  }

  const storeDecision = await store.checkAndConsume(storeInput)

  if (
    rpd !== undefined &&
    storeDecision.rpd !== undefined &&
    !storeDecision.rpd.allowed
  ) {
    return {
      kind: 'defer',
      scope: resolved.scope,
      reason: 'rpd_exhausted',
      retryAfterMs: normalizeRetryAfter(
        storeDecision.rpd.retryAfterMs,
        timeUntilNextUtcDay(nowMs),
      ),
    }
  }

  if (
    rpm !== undefined &&
    storeDecision.rpm !== undefined &&
    !storeDecision.rpm.allowed
  ) {
    return {
      kind: 'defer',
      scope: resolved.scope,
      reason: 'rpm_exhausted',
      retryAfterMs: normalizeRetryAfter(
        storeDecision.rpm.retryAfterMs,
        timeUntilNextMinute(nowMs),
      ),
    }
  }

  return { kind: 'allow' }
}

function messageForDefer(
  reason: QuotaDeferReason,
  scope: string,
  retryAfterMs: number,
): string {
  switch (reason) {
    case 'rpm_exhausted':
      return `Provider quota exhausted for "${scope}": requests per minute exhausted. Retry after ${retryAfterMs}ms.`
    case 'rpd_exhausted':
      return `Provider quota exhausted for "${scope}": requests per day exhausted. Retry after ${retryAfterMs}ms.`
    default: {
      const exhaustive: never = reason
      return exhaustive
    }
  }
}

function messageForDeny(reason: QuotaDenyReason, scope: string): string {
  const messages = {
    provider_disabled: (s: string) => `Provider quota disabled for "${s}".`,
  } satisfies Record<QuotaDenyReason, (scope: string) => string>

  return messages[reason](scope)
}

function emitEvent(onEvent: QuotaEventHandler | undefined, event: QuotaEvent): void {
  if (onEvent === undefined) return

  try {
    onEvent(event)
  } catch {
    // User-supplied event handlers must not alter quota enforcement behavior.
  }
}

function parseRateLimiterKey(key: string): { provider: string; model: string } {
  const firstColon = key.indexOf(':')
  if (firstColon <= 0 || firstColon === key.length - 1) {
    throw new Error(`Invalid provider quota key "${key}"`)
  }

  return {
    provider: key.slice(0, firstColon),
    model: key.slice(firstColon + 1),
  }
}

function buildUpstashInvoker(opts: UpstashQuotaStoreOptions): UpstashPipelineInvoker {
  if (opts.url === undefined || opts.token === undefined) {
    throw new Error(
      'upstashQuotaStore requires either opts.invoke or both opts.url and opts.token',
    )
  }

  const fetchImpl = opts.fetch ?? globalThis.fetch

  const endpoint = `${opts.url.replace(/\/+$/, '')}/pipeline`

  return async function invoke(
    commands: readonly UpstashPipelineCommand[],
    signal?: AbortSignal,
  ): Promise<readonly unknown[]> {
    const requestInit: RequestInit = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    }
    if (signal !== undefined) {
      requestInit.signal = signal
    }

    const response = await fetchImpl(endpoint, requestInit)

    if (!response.ok) {
      throw new Error(`Upstash quota pipeline failed with HTTP ${response.status}`)
    }

    return (await response.json()) as readonly unknown[]
  }
}

function numericPipelineResult(value: unknown): number {
  const unwrapped = unwrapPipelineResult(value)
  if (typeof unwrapped === 'number') return unwrapped
  if (typeof unwrapped === 'string' && unwrapped.length > 0) {
    const parsed = Number(unwrapped)
    if (Number.isFinite(parsed)) return parsed
  }

  throw new Error(`Unexpected Upstash pipeline result: ${JSON.stringify(value)}`)
}

function unwrapPipelineResult(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'result' in value) {
    return value.result
  }
  return value
}

function defaultScope(provider: string, model: string): string {
  return `${provider}:${model}`
}

function normalizeConfiguredLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined
  if (limit <= 0) return undefined
  return limit
}

function validateConfiguredLimit(
  name: 'rpm' | 'rpd',
  value: number | undefined,
): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 0) {
    throw new LlmError(
      `Invalid provider quota rule: "${name}" must be a non-negative integer, got ${value}`,
      { kind: 'bad_request', retryable: false },
    )
  }
  return value
}

function normalizeRetryAfter(
  retryAfterMs: number | undefined,
  fallbackMs: number,
): number {
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    return retryAfterMs
  }
  return fallbackMs
}

function bucketKey(
  prefix: string,
  scope: string,
  window: 'rpm' | 'rpd',
  nowMs: number,
): string {
  if (window === 'rpm') {
    return `${prefix}:${window}:${scope}:${minuteBucket(nowMs)}`
  }
  return `${prefix}:${window}:${scope}:${utcDayBucket(nowMs)}`
}

function minuteBucket(nowMs: number): string {
  const d = new Date(nowMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${y}${m}${day}${hh}${mm}`
}

function utcDayBucket(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10)
}

function timeUntilNextMinute(nowMs: number): number {
  const nextMinute = Math.floor(nowMs / 60_000) * 60_000 + 60_000
  return Math.max(nextMinute - nowMs, 1)
}

function timeUntilNextUtcDay(nowMs: number): number {
  const d = new Date(nowMs)
  const nextDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)
  return Math.max(nextDay - nowMs, 1)
}
