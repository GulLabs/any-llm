/**
 * Structural GeminiClientLike interface + buildGoogleClient factory.
 *
 * This module defines the structural interface the adapter depends on.
 * The real @google/genai SDK is imported ONLY in buildGoogleClient so tests
 * can inject a fake without pulling in the real SDK.
 *
 * @module
 */

import type { AuthMaterial } from '@anyllm/core'

// ---------------------------------------------------------------------------
// Response shape — mirrors the @google/genai surface we actually consume
// ---------------------------------------------------------------------------

/** A single text/thought part in a Gemini candidate content. */
export interface GeminiPartShape {
  text?: string
  /**
   * Present and `true` on thought-summary parts.
   * Real field name in @google/genai Candidate.content.parts: `thought`.
   */
  thought?: boolean
}

/** A candidate returned by Gemini generateContent. */
export interface GeminiCandidateShape {
  content?: {
    parts?: GeminiPartShape[]
  }
  /**
   * Why the model stopped.
   * Real SDK enum (FinishReason): "STOP", "MAX_TOKENS", "SAFETY",
   * "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", etc.
   */
  finishReason?: string
}

/**
 * Token usage metadata returned alongside a Gemini response.
 *
 * Real type: GenerateContentResponseUsageMetadata.
 * NOTE: thoughtsTokenCount is SEPARATE from candidatesTokenCount.
 * The adapter must add them to get GROSS outputTokens.
 */
export interface GeminiUsageMetadataShape {
  promptTokenCount?: number
  candidatesTokenCount?: number
  cachedContentTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

/**
 * Structural equivalent of @google/genai's GenerateContentResponse.
 * Only the fields the adapter reads are represented here.
 */
export interface GeminiResponseShape {
  candidates?: GeminiCandidateShape[]
  usageMetadata?: GeminiUsageMetadataShape
  /** Real field: GenerateContentResponse.modelVersion */
  modelVersion?: string
  /** Real field: GenerateContentResponse.responseId */
  responseId?: string
  /**
   * Safety-block metadata.
   * Real type: GenerateContentResponsePromptFeedback.
   * Present when the prompt (not output) was blocked by safety filters.
   */
  promptFeedback?: {
    /** Real type: BlockedReason (string enum). e.g. "SAFETY", "OTHER". */
    blockReason?: string
    blockReasonMessage?: string
    safetyRatings?: unknown[]
  }
}

// ---------------------------------------------------------------------------
// Request / config shape — what the adapter sends to generateContent
// ---------------------------------------------------------------------------

/** A text part in a content object we construct. */
export interface GeminiContentPart {
  text: string
}

/** A content object (message) we construct. */
export interface GeminiContent {
  role: string
  parts: GeminiContentPart[]
}

/**
 * Schema shape we pass as responseSchema.
 * Structurally compatible with @google/genai Schema.
 */
export interface GeminiSchema {
  type?: string
  description?: string
  properties?: Record<string, GeminiSchema>
  required?: string[]
  items?: GeminiSchema
  enum?: string[]
  nullable?: boolean
  format?: string
}

/**
 * Thinking configuration.
 * Real type: ThinkingConfig in @google/genai.
 * - thinkingBudget: 0 = DISABLED, -1 = AUTOMATIC
 * - thinkingLevel: ThinkingLevel enum ("LOW", "MEDIUM", "HIGH", "MINIMAL")
 */
export interface GeminiThinkingConfig {
  includeThoughts?: boolean
  thinkingBudget?: number
  /**
   * Real type: ThinkingLevel enum.
   * Values: "LOW" | "MEDIUM" | "HIGH" | "MINIMAL" | "THINKING_LEVEL_UNSPECIFIED"
   */
  thinkingLevel?: string
}

/**
 * Config object passed in GenerateContentParameters.config.
 * Real type: GenerateContentConfig.
 * abortSignal is inside config, NOT in the top-level params.
 */
export interface GeminiGenerateConfig {
  systemInstruction?: { parts: GeminiContentPart[] }
  temperature?: number
  topP?: number
  topK?: number
  maxOutputTokens?: number
  stopSequences?: string[]
  responseMimeType?: string
  responseSchema?: GeminiSchema
  thinkingConfig?: GeminiThinkingConfig
  /** Real type: ServiceTier enum. Values: "flex" | "standard". */
  serviceTier?: string
  /** Real field: GenerateContentConfig.abortSignal (NOT in top-level params). */
  abortSignal?: AbortSignal
}

/**
 * Parameters for models.generateContent.
 * Real type: GenerateContentParameters.
 */
export interface GeminiGenerateParams {
  model: string
  contents: GeminiContent[]
  config?: GeminiGenerateConfig
}

// ---------------------------------------------------------------------------
// GeminiClientLike — structural interface (no @google/genai dependency)
// ---------------------------------------------------------------------------

/**
 * Structural interface for the @google/genai client surface the adapter uses.
 *
 * Satisfied by:
 * - The real GoogleGenAI client (via buildGoogleClient wrapper).
 * - FakeGeminiClient from @anyllm/testing (its generateContent accepts unknown).
 */
export interface GeminiClientLike {
  models: {
    generateContent(params: GeminiGenerateParams): Promise<GeminiResponseShape>
  }
}

// ---------------------------------------------------------------------------
// buildGoogleClient — imports the real @google/genai SDK
// ---------------------------------------------------------------------------

/**
 * Build a real @google/genai client from AuthMaterial.
 *
 * Returns a GeminiClientLike wrapper around the real GoogleGenAI client.
 * API key → Gemini Developer API; vertex → Vertex AI (Gemini Enterprise Agent Platform).
 *
 * @param auth - API key or Vertex credentials.
 */
export function buildGoogleClient(auth: AuthMaterial): GeminiClientLike {
  // Import the real SDK — only called at runtime when no client is injected.
  // The cast is safe: GeminiGenerateParams is a structural subset of
  // GenerateContentParameters; GeminiResponseShape is a subset of
  // GenerateContentResponse.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { GoogleGenAI } = require('@google/genai') as typeof import('@google/genai')

  const options =
    'apiKey' in auth
      ? { apiKey: auth.apiKey }
      : {
          // VERIFY: Vertex auth with @google/genai v1.52+
          // GoogleGenAIOptions uses vertexai:true + project + location for Vertex AI.
          vertexai: true,
          project: auth.vertex.project,
          location: auth.vertex.location,
        }

  const ai = new GoogleGenAI(options)

  return {
    models: {
      async generateContent(params: GeminiGenerateParams): Promise<GeminiResponseShape> {
        // Cast needed: our structural types are subsets of the real SDK types.
        const result = await (
          ai.models.generateContent as (
            params: unknown,
          ) => Promise<GeminiResponseShape>
        )(params)
        return result
      },
    },
  }
}
