// Live smoke test: drives the real IdeBridge/RawWs code against a fake
// Claude Code IDE bridge (MCP-over-WebSocket, RFC 6455) on 127.0.0.1.
// Usage: node smoke-test.mjs
import http from 'node:http'
import crypto from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as ide from './index.js'

const PORT = 23333
const TOKEN = 'fake-token-123'
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const log = (...args) => console.log('[test]', ...args)
let passed = 0
let failed = 0
function ok(cond, label) {
  if (cond) { passed++; log(`PASS ${label}`) }
  else { failed++; console.error(`FAIL ${label}`) }
}

// --- minimal RFC 6455 server ------------------------------------------------
const clients = new Set()
const server = http.createServer((req, res) => { res.writeHead(426); res.end() })
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + GUID).digest('base64')
  if (req.headers['sec-websocket-protocol'] !== 'mcp') { socket.destroy(); return }
  if (req.headers['x-claude-code-ide-authorization'] !== TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    'Sec-WebSocket-Protocol: mcp\r\n\r\n'
  )
  const client = { socket, buffer: Buffer.alloc(0) }
  clients.add(client)
  socket.on('data', (chunk) => consume(client, chunk))
  socket.on('close', () => clients.delete(client))
})

function unmask(payload, mask) {
  const out = Buffer.from(payload)
  for (let i = 0; i < out.length; i++) out[i] = out[i] ^ mask[i % 4]
  return out
}
function consume(client, chunk) {
  client.buffer = Buffer.concat([client.buffer, chunk])
  while (client.buffer.length >= 2) {
    const first = client.buffer[0]
    const second = client.buffer[1]
    const opcode = first & 0x0f
    let len = second & 0x7f
    let off = 2
    if (len === 126) { if (client.buffer.length < 4) return; len = client.buffer.readUInt16BE(2); off = 4 }
    else if (len === 127) { if (client.buffer.length < 10) return; len = Number(client.buffer.readBigUInt64BE(2)); off = 10 }
    if (client.buffer.length < off + len) return
    const masked = (second & 0x80) !== 0
    const mask = masked ? client.buffer.subarray(off, off + 4) : null
    const start = masked ? off + 4 : off
    const payload = client.buffer.subarray(start, start + len)
    client.buffer = client.buffer.subarray(start + len)
    if (opcode === 1) {
      const text = unmask(payload, mask).toString('utf8')
      handleJson(client, text)
    }
  }
}
function sendText(client, text) {
  const payload = Buffer.from(text, 'utf8')
  const header = payload.length < 126
    ? Buffer.from([0x81, payload.length])
    : Buffer.concat([Buffer.from([0x81, 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b })()])
  client.socket.write(Buffer.concat([header, payload]))
}

let toolsList = [
  { name: 'getOpenEditors', description: 'opened files' },
  { name: 'getLatestSelection', description: 'selection' },
]
let openedTabs = [
  { uri: 'file:///Users/lsai/work/proj/src/Main.java', isActive: true },
  { fileName: '/Users/lsai/work/proj/pom.xml', isActive: false },
]
function handleJson(client, raw) {
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (msg.method === 'initialize') {
    sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake-ide', version: '1.0' } } }))
    // push a selection after the client confirms initialization
    setTimeout(() => {
      sendText(client, JSON.stringify({
        jsonrpc: '2.0', method: 'selection_changed',
        params: { filePath: '/Users/lsai/work/proj/src/Main.java', selection: { start: { line: 3, character: 1 }, end: { line: 5, character: 9 } }, text: 'int x = 1;\nint y = 2;' },
      }))
    }, 50)
    return
  }
  if (msg.method === 'tools/list') {
    sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: toolsList } }))
    return
  }
  if (msg.method === 'tools/call') {
    const name = msg.params?.name
    if (name === 'getOpenEditors') {
      sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ tabs: openedTabs }) }] } }))
    } else if (name === 'getLatestSelection') {
      sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ filePath: '/Users/lsai/work/proj/src/Main.java', selection: { start: { line: 3, character: 1 }, end: { line: 5, character: 9 } }, text: 'picked' }) }] } }))
    } else {
      sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [] } }))
    }
    return
  }
  if (msg.id !== undefined) {
    sendText(client, JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: {} }))
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, label, timeout = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const v = fn()
    if (v) return v
    await sleep(50)
  }
  throw new Error(`timeout waiting for ${label}`)
}

// --- logger -----------------------------------------------------------------
const logger = {
  warn: (...a) => console.log('[warn]', ...a),
  error: (...a) => console.log('[error]', ...a),
  debug: (...a) => console.log('[debug]', ...a),
  info: () => {},
  success: () => {},
}

// --- run --------------------------------------------------------------------
await new Promise((resolve) => server.listen(PORT, resolve))
log(`fake IDE bridge listening on ws://127.0.0.1:${PORT}`)

const lockDir = mkdtempSync(join(tmpdir(), 'ide-smoke-'))
writeFileSync(join(lockDir, `${PORT}.lock`), JSON.stringify({
  pid: 99999, workspaceFolders: ['/Users/lsai/work/proj'], ideName: 'Visual Studio Code', authToken: TOKEN,
}))

let bridge
try {
  // 1. pure parsing helpers against both dialects
  ok(JSON.stringify(ide.extractOpenedFiles({ content: [{ type: 'text', text: '/a.java\n/b.ts\n' }] })) === JSON.stringify(['/a.java', '/b.ts']), 'extractOpenedFiles newline list')
  ok(JSON.stringify(ide.extractSelectionToolResult({ text: JSON.stringify({ filePath: '/f', selection: { start: { line: 1, character: 0 }, end: { line: 2, character: 3 } }, text: 's' }) })) === JSON.stringify({ filePath: '/f', start: { line: 1, character: 0 }, end: { line: 2, character: 3 }, text: 's' }), 'extractSelectionToolResult')

  // 2. full bridge: lock discovery -> handshake -> tools/list -> poll
  bridge = new ide.IdeBridge(lockDir, 200, logger)
  bridge.start()
  bridge.followWorkspace('/Users/lsai/work/proj')
  await waitFor(() => bridge.latest()?.openedFiles.length === 2, 'opened files via getOpenEditors')
  const snap = bridge.latest()
  ok(snap.ideName === 'Visual Studio Code', 'ideName from lock')
  ok(snap.openedFiles.includes('/Users/lsai/work/proj/src/Main.java'), 'uri decoded to path')
  ok(snap.openedFiles.includes('/Users/lsai/work/proj/pom.xml'), 'fileName used')

  // 3. push-based selection_changed
  await waitFor(() => bridge.latest()?.selection !== undefined, 'selection_changed notification')
  const sel = bridge.latest().selection
  ok(sel.filePath === '/Users/lsai/work/proj/src/Main.java' && sel.start.line === 3 && sel.end.line === 5, 'selection applied')

  // 4. rendered output contains the Claude Code format
  const state = ide.renderState(snap)
  ok(state.includes('The user selected lines 4 to 6 from'), 'rendered selection range (1-based)')
  ok(state.includes('This may or may not be related to the current task.'), 'rendered tail')

  // 5. reconnect: kill the server socket, bridge should reconnect and repoll
  const before = Date.now()
  for (const c of [...clients]) c.socket.destroy()
  clients.clear()
  await sleep(100)
  // mutate tabs so we can observe a fresh poll after reconnect
  openedTabs = [{ fileName: '/Users/lsai/work/proj/after-reconnect.ts' }]
  await waitFor(() => bridge.latest()?.openedFiles.includes('/Users/lsai/work/proj/after-reconnect.ts'), 'reconnect + repoll', 8000)
  ok(true, `reconnected and repolled after ${Date.now() - before}ms`)
  ok(bridge.latest().openedFiles.length === 1, 'opened files updated after reconnect')

  // 6. workspace-mismatch fallback: a second, newer lock in another folder
  const otherPort = PORT + 1
  writeFileSync(join(lockDir, `${otherPort}.lock`), JSON.stringify({
    pid: 1, workspaceFolders: ['/other/proj'], ideName: 'IntelliJ IDEA', authToken: 'tok2',
  }))
  bridge.followWorkspace('/Users/lsai/work/proj')
  await sleep(150)
  const after = bridge.latest()
  ok(after.ideName === 'Visual Studio Code', 'workspace match keeps VS Code lock despite newer IntelliJ lock')

  bridge.dispose()
  log(`done: ${passed} passed, ${failed} failed`)
} finally {
  bridge?.dispose()
  server.close()
  rmSync(lockDir, { recursive: true, force: true })
}
process.exit(failed === 0 ? 0 : 1)
