import { describe, it, expect } from 'vitest'
import { FakeIds } from './ids.js'

describe('FakeIds', () => {
  it('returns sequential call IDs starting at call_1', () => {
    const ids = new FakeIds()
    expect(ids.callId()).toBe('call_1')
    expect(ids.callId()).toBe('call_2')
    expect(ids.callId()).toBe('call_3')
  })

  it('returns sequential attempt IDs starting at attempt_1', () => {
    const ids = new FakeIds()
    expect(ids.attemptId()).toBe('attempt_1')
    expect(ids.attemptId()).toBe('attempt_2')
    expect(ids.attemptId()).toBe('attempt_3')
  })

  it('call and attempt counters are independent', () => {
    const ids = new FakeIds()
    ids.callId()            // call_1
    ids.attemptId()         // attempt_1
    ids.attemptId()         // attempt_2
    expect(ids.callId()).toBe('call_2')
    expect(ids.attemptId()).toBe('attempt_3')
  })

  it('reset() restarts both sequences from 1', () => {
    const ids = new FakeIds()
    ids.callId()    // call_1
    ids.callId()    // call_2
    ids.attemptId() // attempt_1
    ids.reset()
    expect(ids.callId()).toBe('call_1')
    expect(ids.attemptId()).toBe('attempt_1')
  })

  it('satisfies the IdGenerator interface structurally', () => {
    const ids: import('@anyllm/core').IdGenerator = new FakeIds()
    expect(typeof ids.callId()).toBe('string')
    expect(typeof ids.attemptId()).toBe('string')
  })
})
