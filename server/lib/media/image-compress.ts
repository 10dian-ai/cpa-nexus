import sharp from 'sharp'

/**
 * Shrinks inline (base64) images in model requests before they leave CPAN.
 *
 * Phone photos are often 3–8 MB each, and base64 adds another third. Vision
 * models downscale them anyway (OpenAI to about 2048 px, Claude to about
 * 1568 px), but the full bytes still travel through every proxy, where a body
 * limit such as nginx's default `client_max_body_size 1m` rejects the request
 * with HTTP 413 after a long upload. Resizing here keeps what the model sees
 * while cutting the request to a fraction of its size.
 *
 * Supported shapes: OpenAI Chat `image_url`, Responses `input_image`,
 * Anthropic `source: { type: 'base64' }` and Gemini `inline_data`/`inlineData`.
 * Remote URLs, animated images and anything that does not decode are left as
 * they are; an image is only replaced when the result is smaller.
 */
export interface ImageCompressionOptions {
  /** Longest edge in pixels; 0 turns compression off. */
  maxEdge: number
  /** JPEG/WebP quality, 1–100. */
  quality: number
  /** Images below this size and within `maxEdge` are kept untouched. */
  minBytes?: number
}
export interface ImageCompressionStats { images: number; compressed: number; beforeBytes: number; afterBytes: number }

type Json = Record<string, unknown>
interface InlineImage { mime: string; data: string; write(mime: string, data: string): void }

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([\s\S]*)$/i
const DEFAULT_MIN_BYTES = 512 * 1024

function fromDataUrl(value: string, write: (url: string) => void): InlineImage | null {
  const match = DATA_URL.exec(value)
  if (!match) return null
  return { mime: match[1]!.toLowerCase(), data: match[2]!, write: (mime, data) => write(`data:${mime};base64,${data}`) }
}

/** Every inline image in a request body, wherever the protocol puts it. */
function collectImages(node: unknown, found: InlineImage[], depth = 0) {
  if (depth > 64) return
  if (Array.isArray(node)) { for (const item of node) collectImages(item, found, depth + 1); return }
  if (!isObject(node)) return
  // OpenAI Chat: { type: 'image_url', image_url: { url } | url }
  if (node.type === 'image_url') {
    const holder = node.image_url
    if (typeof holder === 'string') { const image = fromDataUrl(holder, url => { node.image_url = url }); if (image) found.push(image) }
    else if (isObject(holder) && typeof holder.url === 'string') { const image = fromDataUrl(holder.url, url => { holder.url = url }); if (image) found.push(image) }
  }
  // Responses: { type: 'input_image', image_url: 'data:…' }
  if (node.type === 'input_image' && typeof node.image_url === 'string') {
    const image = fromDataUrl(node.image_url, url => { node.image_url = url }); if (image) found.push(image)
  }
  // Anthropic: { type: 'image', source: { type: 'base64', media_type, data } }
  if (isObject(node.source) && node.source.type === 'base64' && typeof node.source.data === 'string' && typeof node.source.media_type === 'string') {
    const source = node.source
    found.push({ mime: String(source.media_type).toLowerCase(), data: source.data as string, write: (mime, data) => { source.media_type = mime; source.data = data } })
  }
  // Gemini: { inline_data: { mime_type, data } } or { inlineData: { mimeType, data } }
  for (const [key, mimeKey] of [['inline_data', 'mime_type'], ['inlineData', 'mimeType']] as const) {
    const inline = node[key]
    if (isObject(inline) && typeof inline.data === 'string' && typeof inline[mimeKey] === 'string' && String(inline[mimeKey]).startsWith('image/')) {
      found.push({ mime: String(inline[mimeKey]).toLowerCase(), data: inline.data, write: (mime, data) => { inline[mimeKey] = mime; inline.data = data } })
    }
  }
  for (const [key, value] of Object.entries(node)) if (key !== 'source' && key !== 'inline_data' && key !== 'inlineData') collectImages(value, found, depth + 1)
}

async function shrink(image: InlineImage, options: Required<ImageCompressionOptions>): Promise<{ before: number; after: number }> {
  const input = Buffer.from(image.data, 'base64')
  const before = input.byteLength
  if (!before) return { before, after: before }
  const pipeline = sharp(input, { failOn: 'error', limitInputPixels: 100_000_000 })
  const meta = await pipeline.metadata()
  if (!meta.width || !meta.height || (meta.pages ?? 1) > 1 || meta.format === 'gif' || meta.format === 'svg') return { before, after: before }
  const longest = Math.max(meta.width, meta.height)
  if (before < options.minBytes && longest <= options.maxEdge) return { before, after: before }
  // Keep transparency (WebP), otherwise JPEG; both are accepted by every vision API.
  const resized = pipeline.rotate().resize({ width: options.maxEdge, height: options.maxEdge, fit: 'inside', withoutEnlargement: true })
  const [output, mime] = meta.hasAlpha
    ? [await resized.webp({ quality: options.quality }).toBuffer(), 'image/webp']
    : [await resized.jpeg({ quality: options.quality, mozjpeg: true }).toBuffer(), 'image/jpeg']
  if (output.byteLength >= before) return { before, after: before }
  image.write(mime, output.toString('base64'))
  return { before, after: output.byteLength }
}

/**
 * Returns a copy of `body` with large inline images resized. The original
 * object is never modified, so a failed attempt can be retried elsewhere.
 */
export async function compressRequestImages(body: Json, options: ImageCompressionOptions): Promise<{ body: Json; stats: ImageCompressionStats }> {
  const stats: ImageCompressionStats = { images: 0, compressed: 0, beforeBytes: 0, afterBytes: 0 }
  if (!options.maxEdge || options.maxEdge <= 0) return { body, stats }
  const copy = structuredClone(body)
  const images: InlineImage[] = []
  collectImages(copy, images)
  if (!images.length) return { body, stats }
  const settings = { maxEdge: options.maxEdge, quality: Math.min(100, Math.max(1, options.quality)), minBytes: options.minBytes ?? DEFAULT_MIN_BYTES }
  const results = await Promise.all(images.map(image => shrink(image, settings).catch(() => {
    const size = Math.floor(image.data.length * 3 / 4)
    return { before: size, after: size }
  })))
  for (const result of results) {
    stats.images++
    stats.beforeBytes += result.before
    stats.afterBytes += result.after
    if (result.after < result.before) stats.compressed++
  }
  return { body: stats.compressed ? copy : body, stats }
}
