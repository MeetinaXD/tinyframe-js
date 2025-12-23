import type { TinyFrameChecksum } from './checksum.js'

import checksum from './checksum.js'

/**
 * TinyFrame 解析过程中的内部状态
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
 * TinyFrame 支持的输入数据类型
 */
export type TinyFrameDataLike
  = | Uint8Array
    | ArrayBuffer
    | ArrayBufferView
    | Iterable<number>

/**
 * TinyFrame 回调签名
 */
export type TinyFrameListenerCallback = (frame: TinyFrame, message: Message) => void

/**
 * TinyFrame 监听器配置
 */
export interface TinyFrameListener {
  /**
   * 满足条件时调用的回调
   */
  callback: TinyFrameListenerCallback
}

/**
 * 将输入数据转为 Uint8Array，便于统一处理
 * @param data - 任意受支持的缓冲区
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
 * 以大端格式写入整数，模仿 Node.js Buffer 的行为
 * @param target - 目标缓冲区
 * @param offset - 写入偏移
 * @param value - 需要写入的无符号整数
 * @param byteLength - 占用字节数
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
 * 拼接多个 Uint8Array
 * @param chunks - 需要合并的片段
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
 * 将输入转为 Iterable<number>，供 parser 循环消费
 * @param buffer - 外部缓冲区
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

/**
 * TinyFrame 消息对象，封装帧信息与数据
 */
export class Message {
  /**
   * TinyFrame 分配的帧 ID
   */
  frameID: number
  /**
   * 自定义类型字段
   */
  type: number
  /**
   * 消息载荷
   */
  data: Uint8Array
  /**
   * 是否为回应帧
   */
  isResponse: boolean

  /**
   * @param type - 自定义消息类型
   * @param data - 原始载荷
   */
  constructor(type: number, data: TinyFrameDataLike) {
    this.frameID = 0
    this.type = type
    this.data = toUint8Array(data)
    this.isResponse = false
  }

  /**
   * 保持与旧版 `message.id` 兼容
   */
  get id(): number {
    return this.frameID
  }

  set id(value: number) {
    this.frameID = value
  }

  /**
   * 快速构造回应消息
   * @param data - 回应载荷
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
 * TinyFrame 主状态机，负责收发与解析帧
 */
export class TinyFrame {
  /**
   * 远端角色（1 为从机，0 为主机）
   */
  peer: number
  /**
   * 下一帧待分配的 ID
   */
  nextID: number
  /**
   * 当前解析状态
   */
  state: TinyFrameState
  /**
   * 解析器运行以来的 tick 数
   */
  parserTimeoutTicks: number
  /**
   * Tick 超时阈值，null 禁用
   */
  parserTimeout: number | null
  /**
   * 帧起始字节，未设置则无 SOF
   */
  sofByte: number | null
  /**
   * 发送分片大小
   */
  chunkSize: number
  /**
   * 当前校验器，null 表示关闭
   */
  checksum: TinyFrameChecksum | null

  /**
   * 帧 ID 字段长度（字节）
   */
  idSize: number
  /**
   * 数据长度字段长度（字节）
   */
  lenSize: number
  /**
   * 类型字段长度（字节）
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
   * 具体传输层写函数，需要由使用者赋值
   */
  write: (buffer: Uint8Array) => void
  /**
   * 开始发送前的钩子（用于仲裁总线等）
   */
  claimTx: () => void
  /**
   * 发送完成后的钩子
   */
  releaseTx: () => void

  /**
   * @param peer - 主/从角色标识（0=主，1=从）
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
   * 重置解析器状态
   */
  resetParser(): void {
    this.state = 'sof'
    this.partLen = 0
  }

  /**
   * 取得下一个帧 ID
   */
  getNextID(): number {
    return this.nextID++
  }

  /**
   * 注册 ID 监听器，可选超时 tick
   * @param id - 目标帧 ID
   * @param callback - 对应帧 ID 的监听器
   * @param timeout - 超时 tick，null 表示不超时
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
   * 将监听器的剩余时长恢复到初始值
   * @param callback - 需要续期的监听器
   */
  renewIDListener(callback: TinyFrameListener): void {
    for (const listener of this.idListeners) {
      if (listener.callback === callback) {
        listener.timeout = listener.maxTimeout
      }
    }
  }

  /**
   * 注册指定类型的监听器
   * @param type - 消息类型
   * @param callback - 回调
   */
  addTypeListener(type: number, callback: TinyFrameListener): void {
    this.typeListeners.push({
      type,
      callback,
    })
  }

  /**
   * 注册通用监听器
   * @param callback - 回调
   */
  addGenericListener(callback: TinyFrameListener): void {
    this.genericListeners.push(callback)
  }

  /**
   * 按回调引用移除 ID 监听器
   * @param callback - 监听器引用
   */
  removeIDListener(callback: TinyFrameListener): void {
    const index = this.idListeners.findIndex(listener => listener.callback === callback)
    if (index >= 0) {
      this.idListeners.splice(index, 1)
    }
  }

  /**
   * 按回调引用移除类型监听器
   * @param callback - 监听器引用
   */
  removeTypeListener(callback: TinyFrameListener): void {
    const index = this.typeListeners.findIndex(listener => listener.callback === callback)
    if (index >= 0) {
      this.typeListeners.splice(index, 1)
    }
  }

  /**
   * 移除通用监听器
   * @param callback - 监听器引用
   */
  removeGenericListener(callback: TinyFrameListener): void {
    const index = this.genericListeners.indexOf(callback)
    if (index >= 0) {
      this.genericListeners.splice(index, 1)
    }
  }

  /**
   * 根据消息内容构建 TinyFrame 帧头
   * @param message - 待发送消息
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
   * 发送一帧，可附带一次性监听器
   * @param message - 待发送的消息
   * @param callback - 回应监听器
   * @param timeout - 超时 tick
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
   * 发送消息，不等待回应
   * @param message - 待发送的消息
   */
  send(message: Message): void {
    this.sendFrame(message)
  }

  /**
   * 发送消息并监听回应
   * @param message - 待发送的请求
   * @param listener - 响应监听器
   * @param timeout - 超时 tick
   */
  query(message: Message, listener: TinyFrameListener, timeout: number | null = null): void {
    this.sendFrame(message, listener, timeout)
  }

  /**
   * 发送回应消息，沿用原帧 ID
   * @param message - 回应内容
   */
  respond(message: Message): void {
    message.isResponse = true
    this.send(message)
    message.isResponse = false
  }

  /**
   * 将外部缓冲区全部送入解析器
   * @param buffer - 外部缓冲区
   */
  accept(buffer: TinyFrameDataLike): void {
    for (const byte of asIterable(buffer)) {
      this.acceptByte(byte)
    }
  }

  /**
   * 初始化帧解析所需的字段
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
   * 逐字节地推进状态机
   * @param byte - 新收到的字节
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
            this.handleReceived()
            this.resetParser()
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
          if (this.checksum && this.checksum.sum(this.data) === this.cksum) {
            this.handleReceived()
          }

          this.resetParser()
        }
        break
    }
  }

  /**
   * 解析成功后构建消息并触发监听器
   */
  handleReceived(): void {
    const message = new Message(this.currentType, this.data)
    message.frameID = this.currentID

    for (const listener of this.idListeners.slice()) {
      if (listener.id === message.frameID) {
        listener.callback.callback(this, message)
      }
    }

    for (const listener of this.typeListeners.slice()) {
      if (listener.type === message.type) {
        listener.callback.callback(this, message)
      }
    }

    for (const listener of this.genericListeners.slice()) {
      listener.callback(this, message)
    }
  }

  /**
   * 推进内部 tick，移除超时监听器
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
