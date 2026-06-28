import type { LlmCallRecord, UsageSink } from '@anyllm/core'
import { llmCalls } from './schema.js'

export interface InsertableDb {
  insert(table: unknown): {
    values(v: Record<string, unknown>): {
      onConflictDoNothing(): Promise<unknown>
    }
  }
}

export function drizzleUsageSink(
  db: InsertableDb,
  table = llmCalls,
): UsageSink {
  return {
    async record(r: LlmCallRecord): Promise<void> {
      const row: Record<string, unknown> = {
        recordSchemaVersion: r.recordSchemaVersion,
        callId: r.callId,
        attemptId: r.attemptId,
        callSiteId: r.callSiteId,
        provider: r.provider,
        model: r.model,
        modelVersion: r.modelVersion,
        responseId: r.responseId,
        serviceTier: r.serviceTier,
        status: r.status,
        finishReason: r.finishReason,
        latencyMs: r.latencyMs,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cachedInputTokens: r.cachedInputTokens,
        thinkingTokens: r.thinkingTokens,
        totalTokens: r.totalTokens,
        costMicroUsd: r.costMicroUsd,
        pricingVersion: r.pricingVersion,
        tokenDetails: r.tokenDetails,
        rawUsage: r.rawUsage,
        providerMetadata: r.providerMetadata,
        warnings: r.warnings,
        generationConfig: r.generationConfig,
        reasoningText: r.reasoningText,
        errorKind: r.errorKind,
        errorMessage: r.errorMessage,
        metadata: r.metadata,
        createdAt: new Date(r.createdAt),
      }

      await db.insert(table).values(row).onConflictDoNothing()
    },
  }
}
