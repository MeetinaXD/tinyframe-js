import { describe, expect, it, vi } from 'vitest'

import checksum from '../src/checksum.js'
import { Message, TinyFrame } from '../src/index.js'

const payload = Uint8Array.from([0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01])

const checksumVariants = [checksum.xor, checksum.crc8, checksum.crc16, checksum.crc32]

describe('tinyFrame', () => {
  const expectArrayEqual = (actual: Uint8Array, expected: Uint8Array) => {
    expect(Array.from(actual)).toEqual(Array.from(expected))
  }

  for (const variant of checksumVariants) {
    it(`roundtrips payload with ${variant.name} checksum`, async () => {
      const wire: Uint8Array[] = []

      const tx = new TinyFrame()
      tx.checksum = variant
      tx.write = chunk => wire.push(chunk)

      const rx = new TinyFrame()
      rx.checksum = variant

      let received = null as (Message | null)
      const genericListener = vi.fn((_frame, message) => {
        received = message
      })
      rx.addGenericListener({
        callback: genericListener,
      })

      const outgoing = new Message(0x100 + checksumVariants.indexOf(variant), payload)
      tx.send(outgoing)

      for (const chunk of wire) {
        rx.accept(chunk)
      }

      await vi.waitFor(() => {
        expect(genericListener).toHaveBeenCalled()
        expect(received).not.toBeNull()
      }, { timeout: 50 })

      expect(received?.type).toBe(outgoing.type)
      expectArrayEqual(received!.data, payload)
    })
  }

  it('respond reuses frame id so query listeners resolve', () => {
    const client = new TinyFrame(0)
    const server = new TinyFrame(0)

    client.write = chunk => server.accept(chunk)
    server.write = chunk => client.accept(chunk)

    server.addGenericListener({
      callback: (frame, message) => {
        const response = message.createResponse(Uint8Array.from([0xFF]))
        frame.respond(response)
      },
    })

    const outgoing = new Message(0x42, Uint8Array.from([0x10]))
    let response = null as (Message | null)

    client.query(outgoing, {
      callback: (_frame, message) => {
        response = message
      },
    })

    expect(response).not.toBeNull()
    expect(response?.frameID).toBe(outgoing.frameID)
    expectArrayEqual(response!.data, Uint8Array.from([0xFF]))
  })

  it('invokes id/type/generic listeners when frame matches', () => {
    const wire: Uint8Array[] = []

    const tx = new TinyFrame(0)
    tx.checksum = null
    tx.write = chunk => wire.push(chunk)

    const rx = new TinyFrame(0)
    rx.checksum = null

    const frameID = 0xABCD
    const messageType = 0x22

    const idCallback = vi.fn()
    rx.addIDListener(frameID, {
      callback: idCallback,
    })

    const typeCallback = vi.fn()
    rx.addTypeListener(messageType, {
      callback: typeCallback,
    })

    const genericCallback = vi.fn()
    rx.addGenericListener({
      callback: genericCallback,
    })

    const outgoing = new Message(messageType, payload)
    outgoing.frameID = frameID
    outgoing.isResponse = true
    tx.send(outgoing)

    for (const chunk of wire) {
      rx.accept(chunk)
    }

    expect(idCallback).toHaveBeenCalledTimes(1)
    expect(typeCallback).toHaveBeenCalledTimes(1)
    expect(genericCallback).toHaveBeenCalledTimes(1)
  })
})
