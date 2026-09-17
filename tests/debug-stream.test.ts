import { expect, test } from 'bun:test'

import { observeFirstSse } from '../packages/ineffa/src/debug-stream'

for (const newline of ['\n', '\r\n', '\r']) {
  test(`SSE timing ignores keepalives and handles byte-split ${JSON.stringify(newline)} framing`, async () => {
    const encoder = new TextEncoder()
    let count = 0
    let input!: ReadableStreamDefaultController<Uint8Array>
    const original = new Response(new ReadableStream({ start: (controller) => (input = controller) }), {
      headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-test': 'retained' },
      status: 201,
      statusText: 'Created',
    })
    const response = observeFirstSse(original, () => count++)
    expect(response.status).toBe(201)
    expect(response.statusText).toBe('Created')
    expect(response.headers.get('x-test')).toBe('retained')
    const reader = response.body!.getReader()

    async function send(text: string) {
      // Split even the BOM and multibyte characters across chunks; every byte must survive.
      for (const byte of encoder.encode(text)) {
        const chunk = new Uint8Array([byte])
        input.enqueue(chunk)
        expect((await reader.read()).value).toEqual(chunk)
      }
    }

    await send(`\uFEFF: keepalive${newline}${newline}event: message${newline}id: 1${newline}${newline}`)
    expect(count).toBe(0)
    await send(`data: {"role":"assistant","text":"你好"}${newline}`)
    expect(count).toBe(0)
    await send(newline)
    expect(count).toBe(1)
    await send(`data: another${newline}${newline}data: [DONE]${newline}${newline}`)
    expect(count).toBe(1)
    input.close()
    expect((await reader.read()).done).toBe(true)
  })
}

test('SSE observation forwards cancellation to the remote stream', async () => {
  let reason: unknown
  const response = new Response(new ReadableStream({ cancel: (value) => (reason = value) }), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const observed = observeFirstSse(response, () => {})
  await observed.body!.cancel('abort')
  expect(reason).toBe('abort')
})

test('SSE observation forwards remote errors and does not count incomplete events', async () => {
  let input!: ReadableStreamDefaultController<Uint8Array>
  let count = 0
  const response = new Response(new ReadableStream({ start: (controller) => (input = controller) }), {
    headers: { 'content-type': 'text/event-stream' },
  })
  const reader = observeFirstSse(response, () => count++).body!.getReader()
  input.enqueue(new TextEncoder().encode('data: unfinished\n'))
  await reader.read()
  input.error(new Error('disconnected'))
  await expect(reader.read()).rejects.toThrow('disconnected')
  expect(count).toBe(0)
})

test('non-SSE responses remain untouched', () => {
  const response = Response.json({ error: 'failed' }, { status: 401 })
  expect(
    observeFirstSse(response, () => {
      throw new Error('unexpected SSE')
    })
  ).toBe(response)
})
