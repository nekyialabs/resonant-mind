export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_MULTIPART_IMAGE_BYTES = MAX_IMAGE_BYTES + 64 * 1024;

export class ImageSizeLimitError extends Error {}

/**
 * Message safe to show a caller for an error thrown while handling image
 * input: the module's own messages (plain Error or ImageSizeLimitError) pass
 * through; anything else (a non-Error value, a TypeError or RangeError from
 * lower down) gets `fallback`.
 */
export function imageErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ImageSizeLimitError) return error.message;
  if (error instanceof Error && error.constructor === Error) return error.message;
  return fallback;
}

export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      throw new Error('Invalid Content-Length');
    }
    if (parsedLength > maxBytes) throw new ImageSizeLimitError(`Request exceeds ${maxBytes} bytes`);
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('size limit exceeded');
        throw new ImageSizeLimitError(`Request exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export type ImageFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteImageFetchOptions {
  fetchImpl?: ImageFetch;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

function isUnsafeIpv4(hostname: string): boolean {
  const octets = hostname.split('.');
  if (octets.length !== 4 || octets.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const values = octets.map(Number);
  if (values.some((value) => value > 255)) return true;
  const [a, b, c] = values;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
    || a >= 224;
}

function parseIpv6(hostname: string): Uint16Array | null {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':') || host.includes('%') || (host.match(/::/g)?.length ?? 0) > 1) return null;
  const compressed = host.includes('::');
  const [leftText, rightText = ''] = host.split('::');

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const tokens = side.split(':');
    const words: number[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.includes('.')) {
        if (index !== tokens.length - 1 || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(token)) return null;
        const octets = token.split('.').map(Number);
        if (octets.some((octet) => octet > 255)) return null;
        words.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(token)) return null;
        words.push(Number.parseInt(token, 16));
      }
    }
    return words;
  };

  const left = parseSide(leftText);
  const right = parseSide(rightText);
  if (!left || !right) return null;
  const explicitWords = left.length + right.length;
  if ((!compressed && explicitWords !== 8) || (compressed && explicitWords >= 8)) return null;
  return Uint16Array.from([...left, ...Array(compressed ? 8 - explicitWords : 0).fill(0), ...right]);
}

function ipv6HasPrefix(words: Uint16Array, prefix: readonly number[], bits: number): boolean {
  const fullWords = Math.floor(bits / 16);
  const remainingBits = bits % 16;
  for (let index = 0; index < fullWords; index += 1) {
    if (words[index] !== prefix[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xffff << (16 - remainingBits)) & 0xffff;
  return (words[fullWords] & mask) === ((prefix[fullWords] ?? 0) & mask);
}

function isUnsafeIpv6(hostname: string): boolean {
  if (!hostname.includes(':')) return false;
  const words = parseIpv6(hostname);
  if (!words) return true;

  const specialPrefixes: Array<[readonly number[], number]> = [
    [[0, 0, 0, 0, 0, 0, 0, 0], 128], // unspecified
    [[0, 0, 0, 0, 0, 0, 0, 1], 128], // loopback
    [[0, 0, 0, 0, 0, 0], 96], // deprecated IPv4-compatible
    [[0, 0, 0, 0, 0xffff, 0], 96], // IPv4-translatable
    [[0, 0, 0, 0, 0, 0xffff], 96], // IPv4-mapped
    [[0x64, 0xff9b, 0, 0, 0, 0], 96], // well-known NAT64
    [[0x64, 0xff9b, 1], 48], // local-use NAT64
    [[0x100, 0, 0, 0], 64], // discard-only
    [[0x2001, 0], 32], // Teredo
    [[0x2001, 2], 48], // benchmarking
    [[0x2001, 0x10], 28], // ORCHID
    [[0x2001, 0x20], 28], // ORCHIDv2
    [[0x2001, 0x0db8], 32], // documentation
    [[0x2002], 16], // deprecated 6to4
    [[0xfc00], 7], // unique-local
    [[0xfe80], 10], // link-local
    [[0xfec0], 10], // deprecated site-local
    [[0xff00], 8], // multicast
  ];
  return specialPrefixes.some(([prefix, bits]) => ipv6HasPrefix(words, prefix, bits));
}

export function validateRemoteImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('source_url must be a valid absolute HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('source_url must use https://');
  if (url.username || url.password) throw new Error('source_url must not contain credentials');
  if (url.port && url.port !== '443') throw new Error('source_url must use the default HTTPS port');

  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const blockedSuffixes = ['localhost', '.localhost', '.local', '.internal', '.lan', '.home', '.test', '.invalid'];
  if (!hostname.includes('.') && !hostname.includes(':')) {
    throw new Error('source_url host must be a public fully-qualified name');
  }
  if (blockedSuffixes.some((suffix) => hostname === suffix || hostname.endsWith(suffix))
      || isUnsafeIpv4(hostname)
      || isUnsafeIpv6(hostname)) {
    throw new Error('source_url host must not be local, private, or special-use');
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

async function cancelResponseBody(response: Response, reason: string): Promise<void> {
  if (!response.body) return;
  try {
    await response.body.cancel(reason);
  } catch {
    // Cancellation is best-effort and must never replace the primary fetch error.
  }
}

export async function fetchRemoteImage(
  sourceUrl: string,
  options: RemoteImageFetchOptions = {},
): Promise<Uint8Array> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_IMAGE_BYTES;
  const maxRedirects = options.maxRedirects ?? 3;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('Remote image fetch timed out')),
    timeoutMs,
  );

  try {
    let url = validateRemoteImageUrl(sourceUrl);
    let redirects = 0;
    while (true) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          redirect: 'manual',
          signal: controller.signal,
          headers: { Accept: 'image/jpeg, image/png, image/gif, image/webp' },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error('Remote image fetch timed out');
        throw error;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        await cancelResponseBody(response, 'redirect response discarded');
        if (redirects >= maxRedirects) throw new Error('source_url returned too many redirects');
        const location = response.headers.get('location');
        if (!location) throw new Error('source_url redirect is missing Location');
        url = validateRemoteImageUrl(new URL(location, url).toString());
        redirects += 1;
        continue;
      }
      if (!response.ok) {
        await cancelResponseBody(response, 'non-success response discarded');
        throw new Error(`source_url fetch returned ${response.status} ${response.statusText}`.trim());
      }

      const declaredLength = response.headers.get('content-length');
      if (declaredLength !== null) {
        if (!/^\d+$/.test(declaredLength)) {
          await cancelResponseBody(response, 'invalid content length');
          throw new Error('source_url returned an invalid Content-Length');
        }
        const length = Number(declaredLength);
        if (!Number.isSafeInteger(length)) {
          await cancelResponseBody(response, 'invalid content length');
          throw new Error('source_url returned an invalid Content-Length');
        }
        if (length > maxBytes) {
          await cancelResponseBody(response, 'declared size limit exceeded');
          throw new ImageSizeLimitError(`source_url image is too large (max ${maxBytes} bytes)`);
        }
      }

      if (!response.body) return new Uint8Array();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            throw new ImageSizeLimitError(`source_url image is too large (max ${maxBytes} bytes)`);
          }
          chunks.push(value);
        }
      } catch (error) {
        try {
          await reader.cancel('response stream discarded after error');
        } catch {
          // Preserve the timeout, size, or stream error that caused cancellation.
        }
        if (controller.signal.aborted) throw new Error('Remote image fetch timed out');
        throw error;
      } finally {
        reader.releaseLock();
      }

      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return bytes;
    }
  } finally {
    clearTimeout(timeout);
  }
}

export interface CanonicalImageFormat {
  mime: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  extension: '.jpg' | '.png' | '.gif' | '.webp';
}

const MIME_BY_EXTENSION: Readonly<Record<string, CanonicalImageFormat['mime']>> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

export function canonicalImageMimeFromKey(key: string): CanonicalImageFormat['mime'] | null {
  const lowerKey = key.toLowerCase();
  const extension = Object.keys(MIME_BY_EXTENSION).find((candidate) => lowerKey.endsWith(candidate));
  return extension ? MIME_BY_EXTENSION[extension] : null;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  return signature.every((byte, index) => bytes[index] === byte);
}

const MAX_IMAGE_DIMENSION = 65_535;
const MAX_IMAGE_PIXELS = 100_000_000;

function assertSaneDimensions(width: number, height: number, format: string): void {
  if (width < 1 || height < 1
      || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION
      || width * height > MAX_IMAGE_PIXELS) {
    throw new Error(`${format} has invalid dimensions`);
  }
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validateJpeg(bytes: Uint8Array): void {
  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  let sawEntropy = false;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('JPEG has invalid marker framing');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new Error('JPEG is truncated after a marker prefix');
    const marker = bytes[offset++];
    if (marker === 0x00 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      throw new Error('JPEG has a marker in an invalid position');
    }
    if (marker === 0xd9) {
      if (!sawFrame || !sawScan || !sawEntropy) throw new Error('JPEG has no complete image scan');
      if (offset !== bytes.length) throw new Error('JPEG has trailing data after EOI');
      return;
    }
    if (offset + 2 > bytes.length) throw new Error('JPEG is truncated before segment length');
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new Error('JPEG has an invalid segment length');
    const dataStart = offset + 2;
    const segmentEnd = offset + length;

    const isStartOfFrame = (marker >= 0xc0 && marker <= 0xcf)
      && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isStartOfFrame) {
      if (length < 8) throw new Error('JPEG has a truncated frame header');
      const height = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
      const width = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
      assertSaneDimensions(width, height, 'JPEG');
      const components = bytes[dataStart + 5];
      if (components < 1 || length !== 8 + components * 3) {
        throw new Error('JPEG has an invalid frame component table');
      }
      sawFrame = true;
    }

    if (marker !== 0xda) {
      offset = segmentEnd;
      continue;
    }
    if (!sawFrame || length < 6) throw new Error('JPEG scan appears before a valid frame');
    const components = bytes[dataStart];
    if (components < 1 || length !== 6 + components * 2) throw new Error('JPEG has an invalid scan header');
    sawScan = true;
    offset = segmentEnd;

    while (offset < bytes.length) {
      if (bytes[offset] !== 0xff) {
        sawEntropy = true;
        offset += 1;
        continue;
      }
      if (offset + 1 >= bytes.length) throw new Error('JPEG is truncated in entropy data');
      const escaped = bytes[offset + 1];
      if (escaped === 0x00) {
        sawEntropy = true;
        offset += 2;
      } else if (escaped >= 0xd0 && escaped <= 0xd7) {
        offset += 2;
      } else if (escaped === 0xff) {
        offset += 1;
      } else {
        break;
      }
    }
  }
  throw new Error('JPEG is truncated or has no EOI marker');
}

function validatePng(bytes: Uint8Array): void {
  let offset = 8;
  let chunkIndex = 0;
  let sawIdat = false;
  let idatEnded = false;
  let imagePayloadBytes = 0;

  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('PNG is truncated in a chunk header');
    const length = readUint32BE(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (dataEnd < dataStart || chunkEnd > bytes.length) throw new Error('PNG has an invalid chunk length');
    const type = String.fromCharCode(...bytes.subarray(typeStart, typeStart + 4));
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('PNG has an invalid chunk type');
    if (readUint32BE(bytes, dataEnd) !== crc32(bytes, typeStart, dataEnd)) {
      throw new Error(`PNG ${type} chunk has an invalid CRC`);
    }

    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG must begin with a 13-byte IHDR chunk');
      const width = readUint32BE(bytes, dataStart);
      const height = readUint32BE(bytes, dataStart + 4);
      assertSaneDimensions(width, height, 'PNG');
      const bitDepth = bytes[dataStart + 8];
      const colorType = bytes[dataStart + 9];
      const validDepths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
      };
      if (!validDepths[colorType]?.includes(bitDepth)
          || bytes[dataStart + 10] !== 0 || bytes[dataStart + 11] !== 0 || bytes[dataStart + 12] > 1) {
        throw new Error('PNG has an invalid IHDR payload');
      }
    } else if (type === 'IHDR') {
      throw new Error('PNG contains more than one IHDR chunk');
    }

    if (type === 'IDAT') {
      if (idatEnded) throw new Error('PNG IDAT chunks must be consecutive');
      sawIdat = true;
      imagePayloadBytes += length;
    } else if (sawIdat && type !== 'IEND') {
      idatEnded = true;
    }

    if (type === 'IEND') {
      if (length !== 0 || !sawIdat || imagePayloadBytes === 0) throw new Error('PNG has an invalid IEND or no image data');
      if (chunkEnd !== bytes.length) throw new Error('PNG has trailing data after IEND');
      return;
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  throw new Error('PNG is truncated or has no IEND chunk');
}

function consumeGifSubBlocks(bytes: Uint8Array, start: number, label: string): { end: number; payload: number } {
  let offset = start;
  let payload = 0;
  while (true) {
    if (offset >= bytes.length) throw new Error(`GIF is truncated in ${label} sub-blocks`);
    const length = bytes[offset++];
    if (length === 0) return { end: offset, payload };
    if (offset + length > bytes.length) throw new Error(`GIF has an invalid ${label} sub-block length`);
    payload += length;
    offset += length;
  }
}

function validateGif(bytes: Uint8Array): void {
  if (bytes.length < 13) throw new Error('GIF is truncated before the logical screen descriptor');
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  assertSaneDimensions(width, height, 'GIF');
  let offset = 13;
  const packed = bytes[10];
  if (packed & 0x80) offset += 3 * (1 << ((packed & 0x07) + 1));
  if (offset > bytes.length) throw new Error('GIF is truncated in the global color table');
  let sawImage = false;

  while (offset < bytes.length) {
    const introducer = bytes[offset++];
    if (introducer === 0x3b) {
      if (!sawImage) throw new Error('GIF has no image descriptor');
      if (offset !== bytes.length) throw new Error('GIF has trailing data after the trailer');
      return;
    }
    if (introducer === 0x21) {
      if (offset >= bytes.length) throw new Error('GIF is truncated before an extension label');
      offset += 1;
      offset = consumeGifSubBlocks(bytes, offset, 'extension').end;
      continue;
    }
    if (introducer !== 0x2c) throw new Error('GIF contains an invalid block introducer');
    if (offset + 9 > bytes.length) throw new Error('GIF is truncated in an image descriptor');
    const left = bytes[offset] | (bytes[offset + 1] << 8);
    const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
    const imageWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
    const imageHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
    assertSaneDimensions(imageWidth, imageHeight, 'GIF');
    if (left + imageWidth > width || top + imageHeight > height) throw new Error('GIF image exceeds its logical screen');
    const imagePacked = bytes[offset + 8];
    offset += 9;
    if (imagePacked & 0x80) offset += 3 * (1 << ((imagePacked & 0x07) + 1));
    if (offset >= bytes.length) throw new Error('GIF is truncated before image data');
    const minimumCodeSize = bytes[offset++];
    if (minimumCodeSize < 2 || minimumCodeSize > 8) throw new Error('GIF has an invalid LZW minimum code size');
    const imageData = consumeGifSubBlocks(bytes, offset, 'image data');
    if (imageData.payload === 0) throw new Error('GIF has no compressed image data');
    offset = imageData.end;
    sawImage = true;
  }
  throw new Error('GIF is truncated or has no trailer');
}

function validateWebpPayload(type: string, bytes: Uint8Array, start: number, length: number): void {
  if (type === 'VP8 ') {
    if (length <= 10 || (bytes[start] & 1) !== 0
        || !startsWith(bytes.subarray(start + 3), [0x9d, 0x01, 0x2a])) {
      throw new Error('WebP has an invalid VP8 key frame');
    }
    const width = (bytes[start + 6] | (bytes[start + 7] << 8)) & 0x3fff;
    const height = (bytes[start + 8] | (bytes[start + 9] << 8)) & 0x3fff;
    assertSaneDimensions(width, height, 'WebP');
    return;
  }
  if (type === 'VP8L') {
    if (length <= 5 || bytes[start] !== 0x2f || (bytes[start + 4] & 0xe0) !== 0) {
      throw new Error('WebP has an invalid VP8L header');
    }
    const packed = readUint32LE(bytes, start + 1);
    const width = (packed & 0x3fff) + 1;
    const height = ((packed >>> 14) & 0x3fff) + 1;
    assertSaneDimensions(width, height, 'WebP');
    return;
  }
  if (length !== 10 || (bytes[start] & 0xc1) !== 0) throw new Error('WebP has an invalid VP8X header');
  const width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
  const height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
  assertSaneDimensions(width, height, 'WebP');
}

function validateAnimatedWebpFrame(bytes: Uint8Array, start: number, length: number): void {
  if (length < 24) throw new Error('WebP has a truncated ANMF frame');
  const width = readUint24LE(bytes, start + 6) + 1;
  const height = readUint24LE(bytes, start + 9) + 1;
  assertSaneDimensions(width, height, 'WebP');
  let offset = start + 16;
  const end = start + length;
  let sawPayload = false;
  while (offset < end) {
    if (offset + 8 > end) throw new Error('WebP ANMF has a truncated nested chunk');
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const chunkLength = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const paddedEnd = dataEnd + (chunkLength & 1);
    if (dataEnd < dataStart || paddedEnd > end) throw new Error('WebP ANMF has an invalid nested chunk length');
    if ((chunkLength & 1) && bytes[dataEnd] !== 0) throw new Error('WebP ANMF has invalid chunk padding');
    if (type === 'VP8 ' || type === 'VP8L') {
      if (sawPayload) throw new Error('WebP ANMF contains multiple image payloads');
      validateWebpPayload(type, bytes, dataStart, chunkLength);
      sawPayload = true;
    } else if (type !== 'ALPH' || sawPayload) {
      throw new Error('WebP ANMF contains invalid chunk ordering');
    }
    offset = paddedEnd;
  }
  if (!sawPayload || offset !== end) throw new Error('WebP ANMF has no complete image payload');
}

function validateWebp(bytes: Uint8Array): void {
  if (bytes.length < 20 || readUint32LE(bytes, 4) + 8 !== bytes.length) {
    throw new Error('WebP has trailing data or an invalid RIFF length');
  }
  let offset = 12;
  let firstChunk = true;
  let extended = false;
  let sawImagePayload = false;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) throw new Error('WebP is truncated in a chunk header');
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const length = readUint32LE(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length & 1);
    if (dataEnd < dataStart || paddedEnd > bytes.length) throw new Error('WebP has an invalid chunk length');
    if ((length & 1) && bytes[dataEnd] !== 0) throw new Error('WebP has invalid chunk padding');

    if (firstChunk) {
      if (!['VP8 ', 'VP8L', 'VP8X'].includes(type)) throw new Error('WebP primary chunk is missing or out of order');
      extended = type === 'VP8X';
    } else if (type === 'VP8X') {
      throw new Error('WebP VP8X chunk must be first');
    }
    if (type === 'VP8 ' || type === 'VP8L') {
      if (sawImagePayload) throw new Error('WebP contains multiple primary image payloads');
      validateWebpPayload(type, bytes, dataStart, length);
      sawImagePayload = true;
    } else if (type === 'VP8X') {
      validateWebpPayload(type, bytes, dataStart, length);
    } else if (type === 'ANMF' && extended) {
      validateAnimatedWebpFrame(bytes, dataStart, length);
      sawImagePayload = true;
    } else if (!extended) {
      throw new Error('WebP simple format contains unexpected chunks');
    }
    firstChunk = false;
    offset = paddedEnd;
  }
  if (offset !== bytes.length || !sawImagePayload) throw new Error('WebP has no complete image payload');
}

export function validateImageBytes(bytes: Uint8Array): CanonicalImageFormat {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large (max ${MAX_IMAGE_BYTES} bytes)`);
  }

  if (startsWith(bytes, [0xff, 0xd8])) {
    validateJpeg(bytes);
    return { mime: 'image/jpeg', extension: '.jpg' };
  }

  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    validatePng(bytes);
    return { mime: 'image/png', extension: '.png' };
  }

  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
      || startsWith(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) {
    validateGif(bytes);
    return { mime: 'image/gif', extension: '.gif' };
  }

  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46])
      && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])) {
    validateWebp(bytes);
    return { mime: 'image/webp', extension: '.webp' };
  }

  throw new Error('Unsupported image bytes; accepted formats are JPEG, PNG, GIF, and WebP');
}

export function decodeBase64Image(encoded: string): Uint8Array {
  if (encoded.length > MAX_BASE64_IMAGE_CHARS) {
    throw new Error(`Encoded image_data is too large (max ${MAX_BASE64_IMAGE_CHARS} characters)`);
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('image_data is not valid base64');
  }

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new Error('image_data is not valid base64');
  }
  if (decoded.length > MAX_IMAGE_BYTES) {
    throw new Error(`Decoded image_data is too large (max ${MAX_IMAGE_BYTES} bytes)`);
  }
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}
