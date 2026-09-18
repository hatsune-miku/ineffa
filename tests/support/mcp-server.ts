// Minimal local MCP fixture: no model or network service is contacted.
export {}
let buffered = ''
const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
while (true) {
  const chunk = await reader.read()
  if (chunk.done) break
  buffered += decoder.decode(chunk.value, { stream: true })
  let end: number
  while ((end = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.id === undefined) continue
    let result: unknown = {}
    if (request.method === 'initialize')
      result = {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'ineffa-ui-fixture', version: '1' },
      }
    else if (request.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'ping',
            description: 'Return a local fixture marker.',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      }
    else if (request.method === 'tools/call') result = { content: [{ type: 'text', text: 'MCP_UI_TOOL_OK' }] }
    else if (request.method === 'resources/list') result = { resources: [] }
    else if (request.method === 'resources/templates/list') result = { resourceTemplates: [] }
    else if (request.method === 'prompts/list') result = { prompts: [] }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
}
