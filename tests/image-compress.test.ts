import sharp from 'sharp'
import { beforeAll, describe, expect, it } from 'vitest'
import { compressRequestImages } from '../server/lib/media/image-compress'

/** A noisy photo-like image so that JPEG cannot compress it to nothing. */
async function photo(width: number, height: number, alpha = false) {
  const channels = alpha ? 4 : 3
  const raw = Buffer.alloc(width * height * channels)
  // Smooth gradients with a little deterministic noise, like a real photo.
  let seed = 7
  for (let i = 0; i < raw.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; const pixel = Math.floor(i / channels); raw[i] = ((pixel % width) * 255 / width + (seed >> 24)) & 255 }
  const image = sharp(raw, { raw: { width, height, channels } })
  return (alpha ? image.png() : image.jpeg({ quality: 98 })).toBuffer()
}
const dims = async (base64: string) => { const meta = await sharp(Buffer.from(base64, 'base64')).metadata(); return [meta.width, meta.height, meta.format] }
const options = { maxEdge: 2048, quality: 85 }

describe('inline image compression', () => {
  let big: string, small: string, transparent: string
  beforeAll(async () => {
    big = (await photo(3000, 2000)).toString('base64')
    small = (await photo(64, 64)).toString('base64')
    transparent = (await photo(2600, 1200, true)).toString('base64')
  })

  it('resizes OpenAI chat data URLs and keeps the original body unchanged', async () => {
    const body = { model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${big}` } }] }] }
    const before = JSON.stringify(body)
    const result = await compressRequestImages(body, options)
    expect(JSON.stringify(body)).toBe(before)
    const url = (result.body as any).messages[0].content[1].image_url.url as string
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(await dims(url.split(',')[1]!)).toEqual([2048, 1365, 'jpeg'])
    expect(result.stats).toMatchObject({ images: 1, compressed: 1 })
    expect(result.stats.afterBytes).toBeLessThan(result.stats.beforeBytes)
  })

  it('handles Responses, Anthropic and Gemini shapes and keeps transparency as WebP', async () => {
    const body = {
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${transparent}` }] }],
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: big } }] }],
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: big } }, { inlineData: { mimeType: 'image/jpeg', data: big } }] }],
    }
    const result = await compressRequestImages(body, options) as any
    expect(result.stats).toMatchObject({ images: 4, compressed: 4 })
    expect(result.body.input[0].content[0].image_url.startsWith('data:image/webp;base64,')).toBe(true)
    expect(result.body.messages[0].content[0].source.media_type).toBe('image/jpeg')
    expect((await dims(result.body.messages[0].content[0].source.data))[0]).toBe(2048)
    expect((await dims(result.body.contents[0].parts[0].inline_data.data))[0]).toBe(2048)
    expect((await dims(result.body.contents[0].parts[1].inlineData.data))[0]).toBe(2048)
  })

  it('leaves small images, remote URLs, broken data and disabled settings alone', async () => {
    const body = { messages: [{ role: 'user', content: [
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${small}` } },
      { type: 'image_url', image_url: { url: 'https://example.test/cat.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'not-an-image' } },
    ] }] }
    const result = await compressRequestImages(body, options)
    expect(result.body).toBe(body)
    expect(result.stats).toMatchObject({ images: 2, compressed: 0 })
    expect((await compressRequestImages({ messages: [{ content: [{ type: 'image_url', image_url: `data:image/jpeg;base64,${big}` }] }] }, { maxEdge: 0, quality: 85 })).stats.images).toBe(0)
  })
})
