import { describe, it, expect } from 'vitest'
import { FakeClock } from './clock.js'

describe('FakeClock', () => {
  it('starts at the provided ms value', () => {
    const clock = new FakeClock(1_000)
    expect(clock.now()).toBe(1_000)
  })

  it('defaults to 0 when no start value is given', () => {
    const clock = new FakeClock()
    expect(clock.now()).toBe(0)
  })

  it('advance() increments the current time', () => {
    const clock = new FakeClock(1_000)
    clock.advance(500)
    expect(clock.now()).toBe(1_500)
    clock.advance(200)
    expect(clock.now()).toBe(1_700)
  })

  it('set() jumps to an absolute time', () => {
    const clock = new FakeClock(9_999)
    clock.set(0)
    expect(clock.now()).toBe(0)
    clock.set(42_000)
    expect(clock.now()).toBe(42_000)
  })

  it('advance() then set() is deterministic', () => {
    const clock = new FakeClock(0)
    clock.advance(100)
    clock.advance(200)
    expect(clock.now()).toBe(300)
    clock.set(50)
    expect(clock.now()).toBe(50)
    clock.advance(10)
    expect(clock.now()).toBe(60)
  })

  it('satisfies the Clock interface structurally', () => {
    // Compile-time check: FakeClock is assignable to Clock.
    const clock: import('@anyllm/core').Clock = new FakeClock(0)
    expect(typeof clock.now()).toBe('number')
  })
})
