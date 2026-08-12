/**
 * XaiFileStore unit tests.
 *
 * All tests inject a fake `fetch` — no network.
 *
 * @module
 */

import { describe, it, expect, vi } from 'vitest'
import { LlmError } from '@gullabs/core'
import {
  XaiFileStore,
  XAI_FILE_TTL_MIN_SECONDS,
  XAI_FILE_TTL_MAX_SECONDS,
  XAI_FILE_MAX_BYTES,
} from './file-store.js'

const fakeAuth = { apiKey: 'test-xai-key' }

type FetchCall = {
  url: string
  init: RequestInit
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status })
}

function makeFetch(handler: (call: FetchCall) => Response | Promise<Response>): {
  fetch: typeof fetch
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  const fetchImpl = vi.fn(
    async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      const call: FetchCall = { url, init: init ?? {} }
      calls.push(call)
      return handler(call)
    },
  ) as unknown as typeof fetch
  return { fetch: fetchImpl, calls }
}

/** Read multipart FormData field names in insertion order. */
function formFieldOrder(body: unknown): string[] {
  if (!(body instanceof FormData)) {
    throw new Error('expected FormData body')
  }
  const names: string[] = []
  for (const [name] of body.entries()) {
    names.push(name)
  }
  return names
}

describe('XaiFileStore.upload', () => {
  it('uploads with TTL and maps expires_at → expiresAt', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        id: 'file_abc',
        object: 'file',
        bytes: 3,
        created_at: 1_700_000_000,
        expires_at: 1_700_086_400,
        filename: 'doc.pdf',
        purpose: 'assistants',
      }),
    )

    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const handle = await store.upload({
      data: new Uint8Array([1, 2, 3]),
      filename: 'doc.pdf',
      mimeType: 'application/pdf',
      expiresAfterSeconds: 86_400,
    })

    expect(handle.id).toBe('file_abc')
    expect(handle.filename).toBe('doc.pdf')
    expect(handle.bytes).toBe(3)
    expect(handle.createdAt).toEqual(new Date(1_700_000_000 * 1000))
    expect(handle.expiresAt).toEqual(new Date(1_700_086_400 * 1000))
    expect(handle.purpose).toBe('assistants')
    expect(handle.raw?.['id']).toBe('file_abc')

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/files')
    expect(calls[0]?.init.method).toBe('POST')
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('Authorization')).toBe('Bearer test-xai-key')

    // Multipart order: expires_after before purpose before file.
    expect(formFieldOrder(calls[0]?.init.body)).toEqual([
      'expires_after',
      'purpose',
      'file',
    ])
  })

  it('omits expires_after and expiresAt when TTL not set', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        id: 'file_perm',
        object: 'file',
        bytes: 1,
        created_at: 1_700_000_000,
        expires_at: null,
        filename: 'a.txt',
        purpose: 'assistants',
      }),
    )

    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const handle = await store.upload({
      data: new Uint8Array([9]),
      filename: 'a.txt',
    })

    expect(handle.id).toBe('file_perm')
    expect('expiresAt' in handle).toBe(false)
    expect(formFieldOrder(calls[0]?.init.body)).toEqual(['purpose', 'file'])
  })

  it('rejects TTL below min before network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({
        data: new Uint8Array([1]),
        filename: 'a.txt',
        expiresAfterSeconds: XAI_FILE_TTL_MIN_SECONDS - 1,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('rejects TTL above max before network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({
        data: new Uint8Array([1]),
        filename: 'a.txt',
        expiresAfterSeconds: XAI_FILE_TTL_MAX_SECONDS + 1,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('rejects oversize body before network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const data = new Uint8Array(XAI_FILE_MAX_BYTES + 1)
    await expect(store.upload({ data, filename: 'big.bin' })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty filename before network', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: '  ' }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('classifies HTTP 401 as invalid_auth', async () => {
    const { fetch } = makeFetch(() => jsonResponse({ error: 'Unauthorized' }, 401))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const err = await store
      .upload({ data: new Uint8Array([1]), filename: 'a.txt' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('invalid_auth')
    expect((err as LlmError).provider).toBe('xai')
  })

  it('classifies HTTP 429 as rate_limited', async () => {
    const { fetch } = makeFetch(() => textResponse('slow down', 429))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: 'a.txt' }),
    ).rejects.toMatchObject({ kind: 'rate_limited', provider: 'xai' })
  })

  it('classifies HTTP 500 as server', async () => {
    const { fetch } = makeFetch(() => textResponse('boom', 500))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: 'a.txt' }),
    ).rejects.toMatchObject({ kind: 'server', provider: 'xai' })
  })

  it('annotates ZDR-blocked upload errors', async () => {
    const { fetch } = makeFetch(() =>
      jsonResponse(
        { error: 'Zero Data Retention is enabled; file uploads are disabled' },
        400,
      ),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const err = await store
      .upload({ data: new Uint8Array([1]), filename: 'a.txt' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LlmError)
    expect((err as LlmError).kind).toBe('bad_request')
    expect((err as LlmError).message).toMatch(/Zero Data Retention/i)
  })

  it('rejects missing apiKey at construction', () => {
    expect(() => new XaiFileStore({ auth: { cliSession: true } as never })).toThrow(
      LlmError,
    )
  })
})

describe('XaiFileStore.get / list / getContent', () => {
  it('get maps metadata and sends Bearer auth', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        id: 'file_1',
        filename: 'x.pdf',
        bytes: 10,
        created_at: 100,
        expires_at: 200,
        purpose: 'assistants',
      }),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const handle = await store.get('file_1')
    expect(handle.id).toBe('file_1')
    expect(handle.expiresAt).toEqual(new Date(200_000))
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/files/file_1')
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe(
      'Bearer test-xai-key',
    )
  })

  it('get 404 → bad_request with httpStatus 404', async () => {
    const { fetch } = makeFetch(() => textResponse('gone', 404))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.get('missing')).rejects.toMatchObject({
      kind: 'bad_request',
      httpStatus: 404,
      provider: 'xai',
    })
  })

  it('list maps data + pagination_token', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        data: [
          { id: 'file_a', filename: 'a.txt', bytes: 1, created_at: 1 },
          { id: 'file_b', filename: 'b.txt', bytes: 2, created_at: 2 },
        ],
        pagination_token: 'next-page',
      }),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const result = await store.list({ limit: 10, order: 'desc', sortBy: 'created_at' })
    expect(result.files.map((f) => f.id)).toEqual(['file_a', 'file_b'])
    expect(result.paginationToken).toBe('next-page')
    expect(calls[0]?.url).toContain('limit=10')
    expect(calls[0]?.url).toContain('order=desc')
    expect(calls[0]?.url).toContain('sort_by=created_at')
  })

  it('getContent returns bytes', async () => {
    const { fetch, calls } = makeFetch(
      () => new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const bytes = await store.getContent('file_1')
    expect(Array.from(bytes)).toEqual([7, 8, 9])
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/files/file_1/content')
  })

  it('getContent 404 → bad_request', async () => {
    const { fetch } = makeFetch(() => textResponse('nope', 404))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.getContent('missing')).rejects.toMatchObject({
      kind: 'bad_request',
      httpStatus: 404,
    })
  })
})

describe('XaiFileStore.delete', () => {
  it('DELETE success resolves void', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ id: 'file_1', deleted: true }),
    )
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('file_1')).resolves.toBeUndefined()
    expect(calls[0]?.init.method).toBe('DELETE')
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('DELETE 404 is success and does not call onDeleteError', async () => {
    const { fetch } = makeFetch(() => textResponse('not found', 404))
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('already-gone')).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('double delete both succeed (second is 404)', async () => {
    let n = 0
    const { fetch } = makeFetch(() => {
      n += 1
      if (n === 1) return jsonResponse({ id: 'file_1', deleted: true })
      return textResponse('gone', 404)
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError: vi.fn() })
    await store.delete('file_1')
    await store.delete('file_1')
  })

  it('DELETE 500 fail-opens via onDeleteError and does not throw', async () => {
    const { fetch } = makeFetch(() => textResponse('server down', 500))
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('file_1')).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalledTimes(1)
    expect(onDeleteError.mock.calls[0]?.[0]).toBe('file_1')
    expect(onDeleteError.mock.calls[0]?.[1]).toBeInstanceOf(LlmError)
    expect((onDeleteError.mock.calls[0]?.[1] as LlmError).kind).toBe('server')
  })

  it('DELETE 500 with failClosed throws and does not call onDeleteError', async () => {
    const { fetch } = makeFetch(() => textResponse('server down', 500))
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('file_1', { failClosed: true })).rejects.toMatchObject({
      kind: 'server',
      provider: 'xai',
    })
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('DELETE 404 with failClosed still succeeds', async () => {
    const { fetch } = makeFetch(() => textResponse('not found', 404))
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('gone', { failClosed: true })).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('empty fileId always throws bad_request', async () => {
    const onDeleteError = vi.fn()
    const { fetch, calls } = makeFetch(() => jsonResponse({ deleted: true }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('   ')).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(store.delete('   ', { failClosed: true })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(onDeleteError).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('failClosed deleteAll fails fast on first error', async () => {
    const { fetch } = makeFetch((call) => {
      if (call.url.endsWith('/files/ok')) return jsonResponse({ deleted: true })
      return textResponse('boom', 500)
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError: vi.fn() })
    await expect(
      store.deleteAll(['ok', 'bad'], { failClosed: true }),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('accepts handle objects', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({ id: 'file_h', deleted: true }),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await store.delete({ id: 'file_h' })
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/files/file_h')
  })

  it('deleteAll settles all ids', async () => {
    const { fetch } = makeFetch((call) => {
      if (call.url.endsWith('/files/a')) return jsonResponse({ deleted: true })
      return textResponse('gone', 404)
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.deleteAll(['a', 'b'])).resolves.toBeUndefined()
  })
})

describe('XaiFileStore auth / baseUrl', () => {
  it('uses custom baseUrl', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        id: 'file_x',
        filename: 'f',
        bytes: 0,
        created_at: 1,
      }),
    )
    const store = new XaiFileStore({
      auth: fakeAuth,
      fetch,
      baseUrl: 'https://example.test/v1/',
    })
    await store.get('file_x')
    expect(calls[0]?.url).toBe('https://example.test/v1/files/file_x')
  })
})

describe('XaiFileStore edge cases', () => {
  it('uploads a Blob with custom purpose', async () => {
    const { fetch, calls } = makeFetch(() =>
      jsonResponse({
        id: 'file_blob',
        filename: 'b.txt',
        bytes: 4,
        created_at: 1,
        purpose: 'custom',
      }),
    )
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const handle = await store.upload({
      data: new Blob(['hi'], { type: 'text/plain' }),
      filename: 'b.txt',
      mimeType: 'text/plain',
      purpose: 'custom',
    })
    expect(handle.id).toBe('file_blob')
    expect(formFieldOrder(calls[0]?.init.body)).toEqual(['purpose', 'file'])
  })

  it('rejects non-integer TTL', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({
        data: new Uint8Array([1]),
        filename: 'a.txt',
        expiresAfterSeconds: 3600.5,
      }),
    ).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('rejects empty fileId on get', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ id: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.get('')).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })

  it('rejects invalid list.limit', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ data: [] }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.list({ limit: 0 })).rejects.toMatchObject({ kind: 'bad_request' })
    await expect(store.list({ limit: 101 })).rejects.toMatchObject({
      kind: 'bad_request',
    })
    expect(calls).toHaveLength(0)
  })

  it('list without opts hits bare /files', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ data: [] }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    const result = await store.list()
    expect(result.files).toEqual([])
    expect(calls[0]?.url).toBe('https://api.x.ai/v1/files')
  })

  it('list forwards paginationToken', async () => {
    const { fetch, calls } = makeFetch(() => jsonResponse({ data: [] }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await store.list({ paginationToken: 'tok-1' })
    expect(calls[0]?.url).toContain('pagination_token=tok-1')
  })

  it('upload aborted signal → aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new DOMException('aborted', 'AbortError')
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: 'a.txt' }, ac.signal),
    ).rejects.toMatchObject({ kind: 'aborted' })
  })

  it('get aborted signal → aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new Error('network')
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.get('file_1', ac.signal)).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('getContent aborted signal → aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new Error('network')
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.getContent('file_1', ac.signal)).rejects.toMatchObject({
      kind: 'aborted',
    })
  })

  it('delete aborted signal fail-opens via onDeleteError', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new Error('network')
    })
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('file_1', { signal: ac.signal })).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalled()
    expect((onDeleteError.mock.calls[0]?.[1] as LlmError).kind).toBe('aborted')
  })

  it('delete aborted with failClosed throws aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new Error('network')
    })
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(
      store.delete('file_1', { signal: ac.signal, failClosed: true }),
    ).rejects.toMatchObject({ kind: 'aborted' })
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('getContent non-404 HTTP error is classified', async () => {
    const { fetch } = makeFetch(() => textResponse('nope', 503))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.getContent('file_1')).rejects.toMatchObject({
      kind: 'server',
      provider: 'xai',
    })
  })

  it('getContent transport error without abort is classified', async () => {
    const { fetch } = makeFetch(() => {
      throw new Error('ECONNRESET')
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.getContent('file_1')).rejects.toBeInstanceOf(LlmError)
  })

  it('deleteAll with failClosed:false uses settle path', async () => {
    const { fetch } = makeFetch(() => textResponse('boom', 500))
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(
      store.deleteAll(['a', 'b'], { failClosed: false }),
    ).resolves.toBeUndefined()
    expect(onDeleteError).toHaveBeenCalled()
  })

  it('delete failClosed rethrows when fetch throws LlmError-shaped failure', async () => {
    const { fetch } = makeFetch(() => textResponse('nope', 429))
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError: vi.fn() })
    await expect(store.delete('x', { failClosed: true })).rejects.toMatchObject({
      kind: 'rate_limited',
    })
  })

  it('delete treats thrown LlmError with httpStatus 404 as success', async () => {
    const { fetch } = makeFetch(() => {
      throw new LlmError('gone', {
        kind: 'bad_request',
        retryable: false,
        httpStatus: 404,
        provider: 'xai',
      })
    })
    const onDeleteError = vi.fn()
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError })
    await expect(store.delete('x', { failClosed: true })).resolves.toBeUndefined()
    expect(onDeleteError).not.toHaveBeenCalled()
  })

  it('deleteAll failClosed succeeds when all deletes ok', async () => {
    const { fetch } = makeFetch(() => jsonResponse({ deleted: true }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.deleteAll(['a', 'b'], { failClosed: true }),
    ).resolves.toBeUndefined()
  })

  it('delete aborted when err is already LlmError uses classified path', async () => {
    const ac = new AbortController()
    ac.abort()
    const { fetch } = makeFetch(() => {
      throw new LlmError('pre', { kind: 'server', retryable: true, provider: 'xai' })
    })
    const store = new XaiFileStore({ auth: fakeAuth, fetch, onDeleteError: vi.fn() })
    await expect(
      store.delete('x', { signal: ac.signal, failClosed: true }),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('get non-404 HTTP error is classified', async () => {
    const { fetch } = makeFetch(() => textResponse('nope', 403))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.get('file_1')).rejects.toMatchObject({
      kind: 'invalid_auth',
      provider: 'xai',
    })
  })

  it('upload missing id → server error', async () => {
    const { fetch } = makeFetch(() => jsonResponse({ filename: 'x' }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: 'a.txt' }),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('upload non-JSON body → server error', async () => {
    const { fetch } = makeFetch(() => new Response('not-json', { status: 200 }))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(
      store.upload({ data: new Uint8Array([1]), filename: 'a.txt' }),
    ).rejects.toMatchObject({ kind: 'server' })
  })

  it('default onDeleteError routes through logger when provided', async () => {
    const { fetch } = makeFetch(() => textResponse('boom', 500))
    const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }
    const store = new XaiFileStore({ auth: fakeAuth, fetch, logger })
    await store.delete('file_1')
    expect(logger.error).toHaveBeenCalled()
    expect(logger.error.mock.calls[0]?.[1]).toBe('xai.file.delete.failed')
  })

  it('list HTTP error is classified', async () => {
    const { fetch } = makeFetch(() => textResponse('nope', 500))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.list()).rejects.toMatchObject({ kind: 'server' })
  })

  it('rejects empty fileId on getContent', async () => {
    const { fetch, calls } = makeFetch(() => new Response(new Uint8Array([1])))
    const store = new XaiFileStore({ auth: fakeAuth, fetch })
    await expect(store.getContent('')).rejects.toMatchObject({ kind: 'bad_request' })
    expect(calls).toHaveLength(0)
  })
})
