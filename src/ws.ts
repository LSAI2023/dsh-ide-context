/**
 * Zero-dependency RFC 6455 WebSocket client for the IDE bridge. Speaks single
 * masked text frames (no extensions, no fragmentation), which is exactly what
 * the Claude Code IDE integration's MCP-over-WebSocket server uses. Isolated so
 * the transport can be swapped (or a `ws`-backed implementation substituted)
 * without touching the bridge or protocol layers.
 * @module @deepseek-ai/dsh-ide-context/ws (internal)
 */

import crypto from 'node:crypto'
import http from 'node:http'
import type { Socket } from 'node:net'
import { WS_SUBPROTOCOL } from './constants.js'

/**
 * Callbacks receive already-decoded text (single frames only); the transport
 * owns framing, masking, and the ping/pong handshake.
 */
export interface RawWsCallbacks {
  onopen?: () => void
  onmessage?: (text: string) => void
  onclose?: (code: number, reason: string) => void
  onerror?: (error: Error) => void
}

/** Client-initiated close with the given reason/code. */
export class RawWs {
  private socket: Socket | undefined
  private buffer = Buffer.alloc(0)
  private closed = false

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string>,
    /** Callbacks assigned by the consumer before {@link connect}; mapped to transport events. */
    public readonly callbacks: RawWsCallbacks = {},
  ) {}

  /** Open the WebSocket connection (RFC 6455 handshake). */
  connect(): void {
    const u = new URL(this.url)
    const key = crypto.randomBytes(16).toString('base64')
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname || '/',
      headers: {
        Host: `${u.hostname}:${u.port}`,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Protocol': WS_SUBPROTOCOL,
        ...this.headers,
      },
    })
    req.on('upgrade', (_res, socket) => {
      this.socket = socket
      socket.on('data', (chunk: Buffer) => { this.consume(chunk) })
      socket.on('close', () => {
        if (!this.closed) {
          this.closed = true
          this.callbacks.onclose?.(1006, 'socket closed')
        }
      })
      socket.on('error', (error: Error) => this.callbacks.onerror?.(error))
      this.callbacks.onopen?.()
    })
    req.on('response', (res) => {
      this.callbacks.onerror?.(new Error(`handshake rejected: HTTP ${res.statusCode}`))
      res.resume()
    })
    req.on('error', (error: Error) => this.callbacks.onerror?.(error))
    req.end()
  }

  /** Send one masked text frame. */
  send(text: string): void {
    const payload = Buffer.from(text, 'utf8')
    const mask = crypto.randomBytes(4)
    for (let i = 0; i < payload.length; i++) {
      const byte = payload[i] ?? 0
      const key = mask[i % 4] ?? 0
      payload[i] = byte ^ key
    }
    let header: Buffer
    if (payload.length < 126) {
      header = Buffer.from([0x80 | 0x1, 0x80 | payload.length])
    } else if (payload.length < 65_536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | 0x1
      header[1] = 0x80 | 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | 0x1
      header[1] = 0x80 | 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    this.socket?.write(Buffer.concat([header, mask, payload]))
  }

  /** Close the connection (client-initiated). */
  close(): void {
    this.closed = true
    this.socket?.end()
  }

  /** True when the connection is established and not closed. */
  isOpen(): boolean {
    return !this.closed && this.socket !== undefined
  }

  private consume(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0] ?? 0
      const secondByte = this.buffer[1] ?? 0
      const opcode = firstByte & 0x0f
      let length = secondByte & 0x7f
      let offset = 2
      if (length === 126) {
        if (this.buffer.length < 4) return
        length = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (this.buffer.length < 10) return
        length = Number(this.buffer.readBigUInt64BE(2))
        offset = 10
      }
      if (this.buffer.length < offset + length) return
      const payload = this.buffer.subarray(offset, offset + length)
      this.buffer = this.buffer.subarray(offset + length)
      if (opcode === 0x1) {
        this.callbacks.onmessage?.(payload.toString('utf8'))
      } else if (opcode === 0x9) {
        // ping -> pong (payload echoed back, no mask on server frames)
        const pong = Buffer.concat([Buffer.from([0x8a]), Buffer.from([payload.length]), payload])
        this.socket?.write(pong)
      } else if (opcode === 0x8) {
        this.closed = true
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005
        const reason = payload.length > 2 ? payload.subarray(2).toString() : ''
        this.callbacks.onclose?.(code, reason)
      }
      // 0x0/0x2 fragments and 0xa pongs ignored: the MCP bridge uses single text frames.
    }
  }
}
