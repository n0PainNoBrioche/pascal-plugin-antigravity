import { describe, expect, it } from 'vitest'
import { extractGlbBounds } from './client.ts'

describe('extractGlbBounds', () => {
  it('computes [w, h, d] in meters from glTF POSITION accessor bounds', () => {
    const json = Buffer.from(
      JSON.stringify({
        accessors: [{ min: [-0.5, 0, -0.4], max: [0.5, 1.2, 0.4] }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      }),
      'utf8',
    )
    const pad = (4 - (json.byteLength % 4)) % 4
    const jsonChunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)])
    const header = Buffer.alloc(12)
    header.writeUInt32LE(0x46546c67, 0)
    header.writeUInt32LE(2, 4)
    header.writeUInt32LE(12 + 8 + jsonChunk.byteLength, 8)
    const chunkHdr = Buffer.alloc(8)
    chunkHdr.writeUInt32LE(jsonChunk.byteLength, 0)
    chunkHdr.writeUInt32LE(0x4e4f534a, 4)
    const glb = Buffer.concat([header, chunkHdr, jsonChunk])

    expect(extractGlbBounds(glb)).toEqual([1, 1.2, 0.8])
  })

  it('returns null for invalid buffers', () => {
    expect(extractGlbBounds(Buffer.from('not-a-glb'))).toBeNull()
  })
})
