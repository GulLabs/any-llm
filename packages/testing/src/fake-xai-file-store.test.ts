/**
 * FakeXaiFileStore unit tests.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { FakeXaiFileStore } from './fake-xai-file-store.js'

describe('FakeXaiFileStore', () => {
  it('upload returns id + expiresAt when TTL set', async () => {
    const now = () => 1_700_000_000_000
    const store = new FakeXaiFileStore({ now })
    const handle = await store.upload({
      data: new Uint8Array([1, 2, 3]),
      filename: 'a.pdf',
      expiresAfterSeconds: 86_400,
    })
    expect(handle.id).toMatch(/^file_fake_/)
    expect(handle.bytes).toBe(3)
    expect(handle.expiresAt?.getTime()).toBe(1_700_000_000_000 + 86_400_000)
    expect(store.size).toBe(1)
  })

  it('getContent returns uploaded bytes', async () => {
    const store = new FakeXaiFileStore()
    const handle = await store.upload({
      data: new Uint8Array([9, 8]),
      filename: 'b.txt',
    })
    const bytes = await store.getContent(handle.id)
    expect(Array.from(bytes)).toEqual([9, 8])
  })

  it('delete is idempotent (missing = success)', async () => {
    const store = new FakeXaiFileStore()
    const handle = await store.upload({
      data: new Uint8Array([1]),
      filename: 'c.txt',
    })
    await store.delete(handle.id)
    await store.delete(handle.id)
    expect(store.size).toBe(0)
  })

  it('failClosed delete throws when configured as missing-error', async () => {
    const onDeleteError = vi.fn()
    const store = new FakeXaiFileStore({
      deleteMissingAsError: true,
      onDeleteError,
    })
    await expect(store.delete('missing', { failClosed: true })).rejects.toMatchObject({
      kind: 'server',
    })
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('empty fileId throws bad_request', async () => {
    const store = new FakeXaiFileStore()
    await expect(store.delete('  ')).rejects.toMatchObject({ kind: 'bad_request' })
  })

  it('purges expired files on get', async () => {
    let t = 1_000_000
    const store = new FakeXaiFileStore({ now: () => t })
    const handle = await store.upload({
      data: new Uint8Array([1]),
      filename: 'e.txt',
      expiresAfterSeconds: 3_600,
    })
    t = 1_000_000 + 3_600_000 + 1
    await expect(store.get(handle.id)).rejects.toMatchObject({ httpStatus: 404 })
    expect(store.size).toBe(0)
  })

  it('rejects out-of-range TTL', async () => {
    const store = new FakeXaiFileStore()
    await expect(
      store.upload({
        data: new Uint8Array([1]),
        filename: 'x.txt',
        expiresAfterSeconds: 10,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
  })
})
