/**
 * A minimal ZIP writer — no library, no CDN.
 *
 * Deflates with the browser's built-in CompressionStream where it exists
 * (Chrome 103+, Firefox 113+, Safari 16.4+) and stores uncompressed where it
 * does not, so this works in every browser that can run the app at all. NFO
 * files are XML, which deflates to roughly a fifth of its size.
 *
 * Deliberately not ZIP64: that caps an archive at 65,535 files and 4 GB, which
 * a television series is in no danger of approaching.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Raw deflate, or null when the browser has no CompressionStream. */
async function deflateRaw(bytes) {
  if (typeof CompressionStream !== 'function') return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch {
    return null; // deflate-raw unsupported on this engine
  }
}

/** MS-DOS packed date and time, which is what a ZIP entry carries. */
function dosStamp(date = new Date()) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2));
  const day =
    ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const FLAG_UTF8 = 0x0800; // bit 11: the name below is UTF-8, not CP437

export class ZipBuilder {
  constructor() {
    this.parts = [];      // Uint8Arrays, in file order
    this.entries = [];    // central-directory records to write at the end
    this.offset = 0;      // running byte offset, for local header positions
  }

  get fileCount() {
    return this.entries.length;
  }

  async addText(path, text) {
    return this.addBytes(path, new TextEncoder().encode(text));
  }

  async addBytes(path, bytes) {
    if (this.entries.length >= 0xffff) {
      throw new Error('This archive already holds 65,535 files, the ZIP limit.');
    }
    const name = new TextEncoder().encode(path.replace(/\\/g, '/'));
    const crc = crc32(bytes);

    // Only bother compressing if it actually helps; tiny files often grow.
    const deflated = bytes.length > 64 ? await deflateRaw(bytes) : null;
    const useDeflate = deflated !== null && deflated.length < bytes.length;
    const payload = useDeflate ? deflated : bytes;
    const method = useDeflate ? 8 : 0;

    const { time, day } = dosStamp();

    const header = new Uint8Array(30 + name.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, SIG_LOCAL, true);
    view.setUint16(4, 20, true);            // version needed
    view.setUint16(6, FLAG_UTF8, true);
    view.setUint16(8, method, true);
    view.setUint16(10, time, true);
    view.setUint16(12, day, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);            // no extra field
    header.set(name, 30);

    this.entries.push({
      name, crc, method, time, day,
      compressed: payload.length,
      uncompressed: bytes.length,
      offset: this.offset,
    });

    this.parts.push(header, payload);
    this.offset += header.length + payload.length;
  }

  /** Finish the archive and hand back a Blob ready to download. */
  build() {
    const central = [];
    let centralSize = 0;

    for (const entry of this.entries) {
      const record = new Uint8Array(46 + entry.name.length);
      const view = new DataView(record.buffer);
      view.setUint32(0, SIG_CENTRAL, true);
      view.setUint16(4, 20, true);          // version made by
      view.setUint16(6, 20, true);          // version needed
      view.setUint16(8, FLAG_UTF8, true);
      view.setUint16(10, entry.method, true);
      view.setUint16(12, entry.time, true);
      view.setUint16(14, entry.day, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.compressed, true);
      view.setUint32(24, entry.uncompressed, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint16(30, 0, true);          // extra length
      view.setUint16(32, 0, true);          // comment length
      view.setUint16(34, 0, true);          // disk number start
      view.setUint16(36, 0, true);          // internal attributes
      view.setUint32(38, 0, true);          // external attributes
      view.setUint32(42, entry.offset, true);
      record.set(entry.name, 46);
      central.push(record);
      centralSize += record.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, SIG_EOCD, true);
    endView.setUint16(4, 0, true);          // this disk
    endView.setUint16(6, 0, true);          // disk with central directory
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, this.offset, true);
    endView.setUint16(20, 0, true);         // no archive comment

    return new Blob([...this.parts, ...central, end], { type: 'application/zip' });
  }
}

/** Hand a Blob to the browser as a download. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
