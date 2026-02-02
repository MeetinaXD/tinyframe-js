import type { TinyFrameChecksum } from './checksum.js'

import checksum from './checksum.js'

/**
 * Internal parser states used by TinyFrame
 */
export type TinyFrameState
  = | 'sof'
    | 'id'
    | 'len'
    | 'type'
    | 'headcksum'
    | 'data'
    | 'datacksum'

/**
 * Supported TinyFrame input types
 */
export type TinyFrameDataLike
  = | Uint8Array
    | ArrayBuffer
    | ArrayBufferView
    | Iterable<number>

/**
 * TinyFrame callback signature
 */
export type TinyFrameListenerCallback = (frame: TinyFrame, message: Message) => void

/**
 * TinyFrame listener configuration
 */
export interface TinyFrameListener {
  /**
   * Callback invoked when the condition matches
   */
  callback: TinyFrameListenerCallback
}

/**
 * Convert supported input to a Uint8Array for easier handling
 * @param data - Any supported buffer
 */
function toUint8Array(data: TinyFrameDataLike): Uint8Array {
  if (data instanceof Uint8Array) {
    return data
  }

  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }

  if (data != null && typeof (data as Iterable<number>)[Symbol.iterator] === 'function') {
    return Uint8Array.from(data as Iterable<number>)
  }

  throw new TypeError('Message data must be an ArrayBuffer, Uint8Array, or iterable of numbers')
}

/**
 * Write an integer in big endian order similar to Node.js Buffer
 * @param target - Destination buffer
 * @param offset - Write offset
 * @param value - Unsigned integer to write
 * @param byteLength - Number of bytes
 */
function writeUIntBE(target: Uint8Array, offset: number, value: number, byteLength: number): number {
  let current = value >>> 0
  for (let i = byteLength - 1; i >= 0; i--) {
    target[offset + i] = current & 0xFF
    current = current >>> 8
  }

  return offset + byteLength
}

/**
 * Concatenate multiple Uint8Arrays
 * @param chunks - Fragments to merge
 */
function concatUint8(...chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0

  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }

  return result
}

/**
 * Convert input to Iterable<number> for the parser
 * @param buffer - External buffer
 */
function asIterable(buffer: TinyFrameDataLike): Iterable<number> {
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer)
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(buffer)) {
    const view = buffer as ArrayBufferView
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  }

  if (buffer && typeof (buffer as Iterable<number>)[Symbol.iterator] === 'function') {
    return buffer as Iterable<number>
  }

  throw new TypeError('Input must be iterable or an ArrayBuffer/typed array')
}

function safeCallback<T extends (...args: any[]) => any>(fn: T): T {
  return function (...args) {
    try {
      return fn(...args)
    }
    catch (e) {
      console.error(e)
    }
  } as T
}

/**
 * TinyFrame message encapsulating frame metadata and payload
 */
export class Message {
  /**
   * Frame ID assigned by TinyFrame
   */
  frameID: number
  /**
   * Custom type field
   */
  type: number
  /**
   * Message payload
   */
  data: Uint8Array
  /**
   * Indicates whether this is a response frame
   */
  isResponse: boolean

  /**
   * @param type - Custom message type
   * @param data - Raw payload
   */
  constructor(type: number, data: TinyFrameDataLike) {
    this.frameID = 0
    this.type = type
    this.data = toUint8Array(data)
    this.isResponse = false
  }

  /**
   * Backwards compatible alias for `message.id`
   */
  get id(): number {
    return this.frameID
  }

  set id(value: number) {
    this.frameID = value
  }

  /**
   * Quickly create a response message
   * @param data - Response payload
   */
  createResponse(data: TinyFrameDataLike): Message {
    const message = new Message(this.type, data)
    message.frameID = this.frameID
    message.isResponse = true
    return message
  }
}

interface IDListenerEntry {
  id: number
  callback: TinyFrameListener
  timeout: number | null
  maxTimeout: number | null
}

interface TypedListenerEntry {
  type: number
  callback: TinyFrameListener
}

/**
 * TinyFrame state machine handling TX/RX and parsing
 */
export class TinyFrame {
  /**
   * Peer role (1 for slave, 0 for master)
   */
  peer: number
  /**
   * Next frame ID to allocate
   */
  nextID: number
  /**
   * Current parser state
   */
  state: TinyFrameState
  /**
   * Number of ticks since the parser started
   */
  parserTimeoutTicks: number
  /**
   * Tick timeout threshold, null disables it
   */
  parserTimeout: number | null
  /**
   * SOF byte if set, otherwise SOF-less
   */
  sofByte: number | null
  /**
   * Chunk size when sending
   */
  chunkSize: number
  /**
   * Current checksum handler, null disables checksum
   */
  checksum: TinyFrameChecksum | null

  /**
   * Frame ID field length (bytes)
   */
  idSize: number
  /**
   * Data length field size (bytes)
   */
  lenSize: number
  /**
   * Type field size (bytes)
   */
  typeSize: number

  private partLen: number
  private currentID: number
  private len: number
  private currentType: number
  private cksum: number
  private data: number[]

  private idListeners: IDListenerEntry[]
  private typeListeners: TypedListenerEntry[]
  private genericListeners: TinyFrameListener[]

  /**
   * Transport write function provided by the user
   */
  write: (buffer: Uint8Array) => void
  /**
   * Hook before TX starts (e.g. bus arbitration)
   */
  claimTx: () => void
  /**
   * Hook after TX completes
   */
  releaseTx: () => void

  /**
   * @param peer - Role identifier (0=master, 1=slave)
   */
  constructor(peer = 1) {
    this.peer = peer
    this.nextID = 0
    this.state = 'sof'
    this.parserTimeoutTicks = 0
    this.parserTimeout = null
    this.sofByte = null
    this.chunkSize = 1024
    this.checksum = checksum.xor

    this.idSize = 4
    this.lenSize = 4
    this.typeSize = 4

    this.partLen = 0
    this.currentID = 0
    this.len = 0
    this.currentType = 0
    this.cksum = 0
    this.data = []

    this.idListeners = []
    this.typeListeners = []
    this.genericListeners = []

    this.write = () => {
      throw new Error('No write implementation')
    }
    this.claimTx = () => {}
    this.releaseTx = () => {}
  }

  /**
   * Reset parser state
   */
  resetParser(): void {
    this.state = 'sof'
    this.partLen = 0
  }

  /**
   * Get the next frame ID
   */
  getNextID(): number {
    return this.nextID++
  }

  /**
   * Register an ID listener with optional timeout ticks
   * @param id - Target frame ID
   * @param callback - Listener for the frame ID
   * @param timeout - Timeout ticks, null disables timeout
   */
  addIDListener(id: number, callback: TinyFrameListener, timeout: number | null = null): void {
    this.idListeners.push({
      id,
      callback,
      timeout,
      maxTimeout: timeout,
    })
  }

  /**
   * Renew a listener timeout back to its initial value
   * @param callback - Listener to renew
   */
  renewIDListener(callback: TinyFrameListener): void {
    for (const listener of this.idListeners) {
      if (listener.callback === callback) {
        listener.timeout = listener.maxTimeout
      }
    }
  }

  /**
   * Register a listener for a specific type
   * @param type - Message type
   * @param callback - Callback
   */
  addTypeListener(type: number, callback: TinyFrameListener): void {
    this.typeListeners.push({
      type,
      callback,
    })
  }

  /**
   * Register a generic listener
   * @param callback - Callback
   */
  addGenericListener(callback: TinyFrameListener): void {
    this.genericListeners.push(callback)
  }

  /**
   * Remove an ID listener by callback reference
   * @param callback - Listener reference
   */
  removeIDListener(callback: TinyFrameListener): void {
    const index = this.idListeners.findIndex(listener => listener.callback === callback)
    if (index >= 0) {
      this.idListeners.splice(index, 1)
    }
  }

  /**
   * Remove a type listener by callback reference
   * @param callback - Listener reference
   */
  removeTypeListener(callback: TinyFrameListener): void {
    const index = this.typeListeners.findIndex(listener => listener.callback === callback)
    if (index >= 0) {
      this.typeListeners.splice(index, 1)
    }
  }

  /**
   * Remove a generic listener
   * @param callback - Listener reference
   */
  removeGenericListener(callback: TinyFrameListener): void {
    const index = this.genericListeners.indexOf(callback)
    if (index >= 0) {
      this.genericListeners.splice(index, 1)
    }
  }

  /**
   * Compose the TinyFrame header based on the message
   * @param message - Message to send
   */
  composeHead(message: Message): Uint8Array {
    let id = message.isResponse ? message.frameID : this.getNextID()

    if (this.peer === 1) {
      id |= 1 << (this.idSize * 8 - 1)
    }

    message.frameID = id

    const headerLength
      = (Number.isFinite(this.sofByte) ? 1 : 0)
        + this.idSize
        + this.lenSize
        + this.typeSize
        + (this.checksum ? this.checksum.size : 0)
    const buffer = new Uint8Array(headerLength)
    let offset = 0

    if (Number.isFinite(this.sofByte)) {
      buffer[offset++] = Number(this.sofByte)
    }

    offset = writeUIntBE(buffer, offset, id, this.idSize)
    offset = writeUIntBE(buffer, offset, message.data.length, this.lenSize)
    offset = writeUIntBE(buffer, offset, message.type, this.typeSize)

    if (this.checksum) {
      const headerEnd = offset
      const headerView = buffer.subarray(0, headerEnd)
      writeUIntBE(buffer, offset, this.checksum.sum(headerView), this.checksum.size)
    }

    return buffer
  }

  /**
   * Send a frame, optionally attaching a one-shot listener
   * @param message - Message to send
   * @param callback - Response listener
   * @param timeout - Timeout ticks
   */
  sendFrame(message: Message, callback?: TinyFrameListener, timeout: number | null = null): void {
    this.claimTx()

    let buffer = this.composeHead(message)

    if (callback) {
      this.addIDListener(message.frameID, callback, timeout)
    }

    let body = message.data

    if (this.checksum && body.length) {
      const sumBuffer = new Uint8Array(this.checksum.size)
      writeUIntBE(sumBuffer, 0, this.checksum.sum(body), this.checksum.size)
      body = concatUint8(body, sumBuffer)
    }

    buffer = concatUint8(buffer, body)

    let cursor = 0

    while (cursor < buffer.length) {
      this.write(buffer.subarray(cursor, cursor + this.chunkSize))
      cursor += this.chunkSize
    }

    this.releaseTx()
  }

  /**
   * Send a message without waiting for a response
   * @param message - Message to send
   */
  send(message: Message): void {
    this.sendFrame(message)
  }

  /**
   * Send a message and listen for the response
   * @param message - Request to send
   * @param listener - Response listener
   * @param timeout - Timeout ticks
   */
  query(message: Message, listener: TinyFrameListener, timeout: number | null = null): void {
    this.sendFrame(message, listener, timeout)
  }

  /**
   * Send a response message reusing the frame ID
   * @param message - Response payload
   */
  respond(message: Message): void {
    message.isResponse = true
    this.send(message)
    message.isResponse = false
  }

  /**
   * Feed an external buffer into the parser
   * @param buffer - External buffer
   */
  accept(buffer: TinyFrameDataLike): void {
    for (const byte of asIterable(buffer)) {
      this.acceptByte(byte)
    }
  }

  /**
   * Initialize parsing for a new frame
   */
  beginFrame(): void {
    this.state = 'id'
    this.partLen = 0
    this.currentID = 0
    this.len = 0
    this.currentType = 0
    this.cksum = 0
    this.data = []
  }

  /**
   * Advance the state machine byte by byte
   * @param byte - Newly received byte
   */
  acceptByte(byte: number): void {
    if (typeof this.parserTimeout === 'number' && Number.isFinite(this.parserTimeout)) {
      if (this.parserTimeoutTicks > this.parserTimeout) {
        this.resetParser()
      }
    }

    if (this.state === 'sof' && !Number.isFinite(this.sofByte)) {
      this.beginFrame()
    }

    switch (this.state) {
      case 'sof':
        if (Number.isFinite(this.sofByte) && byte === Number(this.sofByte)) {
          this.beginFrame()
          this.data.push(byte)
        }
        break
      case 'id':
        this.data.push(byte)

        this.currentID = (this.currentID << 8) | byte
        if (++this.partLen === this.idSize) {
          this.state = 'len'
          this.partLen = 0
        }

        break
      case 'len':
        this.data.push(byte)

        this.len = (this.len << 8) | byte
        if (++this.partLen === this.lenSize) {
          this.state = 'type'
          this.partLen = 0
        }
        break
      case 'type':
        this.data.push(byte)

        this.currentType = (this.currentType << 8) | byte
        if (++this.partLen === this.typeSize) {
          this.state = this.checksum ? 'headcksum' : 'data'
          this.partLen = 0
        }
        break
      case 'headcksum':
        this.cksum = ((this.cksum << 8) | byte) >>> 0
        if (++this.partLen === (this.checksum?.size ?? 0)) {
          if (!this.checksum || this.checksum.sum(this.data) !== this.cksum) {
            this.resetParser()
            break
          }

          this.data.push(byte)

          if (this.len === 0) {
            this.handleReceived()
            this.resetParser()
            break
          }

          this.partLen = 0
          this.data = []
          this.state = 'data'
        }
        break
      case 'data':
        this.data.push(byte)

        if (++this.partLen === this.len) {
          if (!this.checksum) {
            this.resetParser()
            this.handleReceived()
            break
          }
          else {
            this.state = 'datacksum'
            this.partLen = 0
            this.cksum = 0
          }
        }
        break
      case 'datacksum':
        this.cksum = ((this.cksum << 8) | byte) >>> 0
        if (++this.partLen === (this.checksum?.size ?? 0)) {
          this.resetParser()
          if (this.checksum && this.checksum.sum(this.data) === this.cksum) {
            this.handleReceived()
          }
        }
        break
    }
  }

  /**
   * Build the message and notify listeners after parsing succeeds
   */
  handleReceived(): void {
    const message = new Message(this.currentType, this.data)
    message.frameID = this.currentID

    for (const listener of this.idListeners.slice()) {
      if (listener.id === message.frameID) {
        safeCallback(listener.callback.callback)(this, message)
      }
    }

    for (const listener of this.typeListeners.slice()) {
      if (listener.type === message.type) {
        safeCallback(listener.callback.callback)(this, message)
      }
    }

    for (const listener of this.genericListeners.slice()) {
      safeCallback(listener.callback)(this, message)
    }
  }

  /**
   * Advance internal ticks and remove timed-out listeners
   */
  tick(): void {
    this.parserTimeoutTicks++

    const removeKeys: number[] = []
    for (let i = 0; i < this.idListeners.length; i++) {
      const listener = this.idListeners[i]
      if (typeof listener.timeout === 'number') {
        listener.timeout -= 1
        if (listener.timeout <= 0) {
          removeKeys.push(i)
        }
      }
    }

    let offset = 0
    for (const index of removeKeys) {
      this.idListeners.splice(index + offset, 1)
      offset -= 1
    }
  }
}

export type { TinyFrameChecksum } from './checksum'
