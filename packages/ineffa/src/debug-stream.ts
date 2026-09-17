/** Observe SSE framing without consuming a second copy or retaining the response body. */
export function observeFirstSse(response: Response, onFirstEvent: () => void): Response {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
  if (!response.body || contentType !== 'text/event-stream') return response

  const decoder = new TextDecoder()
  let prefix = ''
  let lineLength = 0
  let hasData = false
  let skipLf = false
  let observed = false

  function endLine() {
    if (lineLength === 0 && hasData) {
      observed = true
      onFirstEvent()
    } else if (prefix === 'data:' || (lineLength === 4 && prefix === 'data')) {
      hasData = true
    }
    prefix = ''
    lineLength = 0
  }

  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!observed) {
          const text = decoder.decode(chunk, { stream: true })
          for (const char of text) {
            if (skipLf && char === '\n') {
              skipLf = false
              continue
            }
            skipLf = char === '\r'
            if (char === '\r' || char === '\n') {
              endLine()
              if (observed) break
            } else {
              // Only the field name matters; large data/comment lines need no retained buffer.
              if (prefix.length < 5) prefix += char
              lineLength++
            }
          }
        }
        controller.enqueue(chunk)
      },
    })
  )

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
