/**
 * normalizeGroundingCitations — unit tests.
 *
 * @module
 */

import { describe, it, expect } from 'vitest'
import { normalizeGroundingCitations } from './grounding.js'

describe('normalizeGroundingCitations', () => {
  it('dedupes chunks with duplicate URLs, keeping first-seen order', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://example.com/a', title: 'Example A' } },
        { web: { uri: 'https://other.com/b', title: 'Other B' } },
        { web: { uri: 'https://example.com/a', title: 'Example A (dup)' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://example.com/a', sourceName: 'Example A' },
      { url: 'https://other.com/b', sourceName: 'Other B' },
    ])
  })

  it('falls back to hostname (without www.) when title is missing', () => {
    const groundingMetadata = {
      groundingChunks: [{ web: { uri: 'https://www.example.com/page' } }],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://www.example.com/page', sourceName: 'example.com' },
    ])
  })

  it('prefers title over hostname when both are present', () => {
    const groundingMetadata = {
      groundingChunks: [
        { web: { uri: 'https://www.example.com/page', title: 'Example Site' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([
      { url: 'https://www.example.com/page', sourceName: 'Example Site' },
    ])
  })

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['empty object', {}],
  ])('returns [] for empty/missing grounding metadata (%s)', (_label, input) => {
    expect(normalizeGroundingCitations(input)).toEqual([])
  })

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 42],
    ['groundingChunks not an array', { groundingChunks: 'nope' }],
    ['groundingChunks missing', { somethingElse: true }],
  ])('returns [] for malformed top-level shape (%s)', (_label, input) => {
    expect(normalizeGroundingCitations(input)).toEqual([])
  })

  it('skips individual malformed chunks without bailing the whole array', () => {
    const groundingMetadata = {
      groundingChunks: [
        null,
        'not-an-object',
        {},
        { web: {} },
        { web: { uri: 'not a valid url' } },
        { web: { uri: 'https://good.example.com/', title: 'Good' } },
      ],
    }

    const citations = normalizeGroundingCitations(groundingMetadata)

    expect(citations).toEqual([{ url: 'https://good.example.com/', sourceName: 'Good' }])
  })
})
