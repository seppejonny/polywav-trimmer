import fs from "node:fs";
import path from "node:path";
import { XMLParser, XMLBuilder } from "fast-xml-parser";

type Chunk = { id: string; size: number; dataOffset: number };

function u16le(buf: Buffer, off: number) { return buf.readUInt16LE(off); }
function u32le(buf: Buffer, off: number) { return buf.readUInt32LE(off); }

function readChunks(fd: number): { riffSize: number; chunks: Chunk[] } {
  const hdr = Buffer.alloc(12);
  fs.readSync(fd, hdr, 0, 12, 0);

  const riff = hdr.toString("ascii", 0, 4);
  const riffSize = u32le(hdr, 4);
  const wave = hdr.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") throw new Error("Not a RIFF/WAVE file.");

  const chunks: Chunk[] = [];
  let pos = 12;

  // Iterate chunks until EOF
  const stat = fs.fstatSync(fd);
  while (pos + 8 <= stat.size) {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, pos);
    const id = head.toString("ascii", 0, 4);
    const size = u32le(head, 4);
    const dataOffset = pos + 8;

    const dataEnd = dataOffset + size;
    if (dataEnd > stat.size) {
      throw new Error(`Invalid chunk size for "${id}": ${size} (file size ${stat.size}). File may be corrupt.`);
    }

    chunks.push({ id, size, dataOffset });

    // word alignment: chunks are padded to even
    const padded = size + (size % 2);
    pos = dataOffset + padded;
  }
  return { riffSize, chunks };
}

function readChunkData(fd: number, ch: Chunk): Buffer {
  const buf = Buffer.alloc(ch.size);
  fs.readSync(fd, buf, 0, ch.size, ch.dataOffset);
  return buf;
}

type Fmt = {
  audioFormat: number; // 1=PCM, 3=float
  numChannels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  fmtSize: number;
  raw: Buffer;
};

function parseFmt(fmtBuf: Buffer): Fmt {
  // PCM WAVEFORMATEX minimal is 16 bytes; can be longer.
  const audioFormat = u16le(fmtBuf, 0);
  const numChannels = u16le(fmtBuf, 2);
  const sampleRate = u32le(fmtBuf, 4);
  const byteRate = u32le(fmtBuf, 8);
  const blockAlign = u16le(fmtBuf, 12);
  const bitsPerSample = u16le(fmtBuf, 14);

  return {
    audioFormat, numChannels, sampleRate, byteRate, blockAlign, bitsPerSample,
    fmtSize: fmtBuf.length,
    raw: fmtBuf
  };
}

function buildFmt(original: Fmt, newChannels: number): Buffer {
  const out = Buffer.from(original.raw); // keep any extension bytes
  out.writeUInt16LE(newChannels, 2);

  const bytesPerSample = original.bitsPerSample / 8;
  const newBlockAlign = newChannels * bytesPerSample;
  const newByteRate = original.sampleRate * newBlockAlign;

  out.writeUInt16LE(newBlockAlign, 12);
  out.writeUInt32LE(newByteRate, 8);
  return out;
}

// Patch chna: filter to kept channels and remap indices to new order.
function patchCHNA(chna: Buffer, keep: number[]): Buffer {
  if (chna.length < 4) return chna;
  const numTracks = u16le(chna, 0);
  const numUIDs = u16le(chna, 2);
  const keepIndexMap = new Map<number, number>();
  keep.forEach((k, i) => keepIndexMap.set(k, i + 1));

  const entrySize = 40;
  const start = 4;
  const maxEntries = Math.floor((chna.length - start) / entrySize);
  const entries = Math.min(numUIDs, maxEntries);
  const kept: Buffer[] = [];
  const trackIndexSet = new Set<number>();

  for (let i = 0; i < entries; i++) {
    const off = start + i * entrySize;
    const entry = Buffer.from(chna.subarray(off, off + entrySize));
    const trackIndex = u16le(entry, 0);
    const channelIndex = u16le(entry, 2);
    const newIndex = keepIndexMap.get(channelIndex);
    if (!newIndex) continue;
    entry.writeUInt16LE(newIndex, 2);
    if (Number.isFinite(trackIndex)) entry.writeUInt16LE(newIndex, 0);
    trackIndexSet.add(newIndex);
    kept.push(entry);
  }

  if (kept.length === 0) return chna;

  const out = Buffer.alloc(4 + kept.length * entrySize);
  out.writeUInt16LE(trackIndexSet.size || Math.min(numTracks, kept.length), 0);
  out.writeUInt16LE(kept.length, 2);
  kept.forEach((buf, i) => buf.copy(out, 4 + i * entrySize));
  return out;
}

// Best-effort iXML patch: keep TRACK entries for kept channel indices (1-based in metadata is common)
function patchIXML(ixml: Buffer, keep: number[]): Buffer {
  const xmlStr = ixml.toString("utf8").replace(/\u0000+$/g, "");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@_", format: true });

  try {
    const obj = parser.parse(xmlStr);

    // Heuristic: find a TRACK_LIST node somewhere
    // Common shapes vary; we do a recursive walk.
    const keepSet = new Set(keep.map(k => Number(k)));
    const keepIndexMap = new Map<number, number>();
    keep.forEach((k, i) => keepIndexMap.set(k, i + 1));
    let didChange = false;

    function remapField(t: any, field: string) {
      if (typeof t[field] === "undefined") return;
      const n = Number(t[field]);
      if (!Number.isFinite(n)) return;
      const mapped = keepIndexMap.get(n);
      if (!mapped) return;
      t[field] = String(mapped);
    }

    function walk(node: any): void {
      if (!node || typeof node !== "object") return;

      for (const k of Object.keys(node)) {
        const v = node[k];

        // TRACK_LIST might hold TRACK array
        if (k.toUpperCase() === "TRACK_LIST" && v) {
          // Cases: TRACK_LIST: { TRACK: [...] } OR TRACK_LIST: { TRACK: {...} }
          const tracks = v.TRACK ?? v.Track ?? v.track;
          if (tracks) {
            const arr = Array.isArray(tracks) ? tracks : [tracks];

            let matchedAny = false;
            let hadIndex = false;
            const filtered = arr.filter((t: any) => {
              // Common fields: CHANNEL_INDEX, TRACK_INDEX, or NAME only
              const idx =
                Number(t.CHANNEL_INDEX ?? t.ChannelIndex ?? t.TRACK_INDEX ?? t.TrackIndex ?? t.TRACK_NO ?? t.TrackNo);
              if (Number.isFinite(idx)) {
                hadIndex = true;
                if (keepSet.has(idx)) {
                  matchedAny = true;
                  remapField(t, "CHANNEL_INDEX");
                  remapField(t, "ChannelIndex");
                  remapField(t, "TRACK_INDEX");
                  remapField(t, "TrackIndex");
                  remapField(t, "TRACK_NO");
                  remapField(t, "TrackNo");
                  return true;
                }
                return false;
              }
              return true; // if unknown, don't drop it
            });

            // Only apply if we matched at least one track by index; otherwise leave intact.
            if (matchedAny) {
              didChange = true;
              if (Array.isArray(tracks)) v.TRACK = filtered;
              else v.TRACK = filtered[0] ?? tracks;

              // Update obvious count fields/attributes
              if (typeof v["@_COUNT"] !== "undefined") v["@_COUNT"] = String(filtered.length);
              if (typeof v.COUNT !== "undefined") v.COUNT = String(filtered.length);
              if (typeof node.TRACK_COUNT !== "undefined") node.TRACK_COUNT = String(filtered.length);
            } else if (hadIndex) {
              // If indexes exist but none matched, avoid zeroing counts by leaving original intact.
              return;
            }
          }
        }

        if (typeof v === "object") walk(v);
      }
    }

    walk(obj);

    // Also patch simple TRACK_COUNT tags if present
    if (!didChange) return ixml;

    const rebuilt = builder.build(obj) as string;
    return Buffer.from(rebuilt, "utf8");
  } catch {
    // If parsing fails, keep original iXML unchanged
    return ixml;
  }
}

export async function trimWav(
  input: string,
  keep: number[],
  opts?: {
    outDir?: string;
    validateWithBwfmetaedit?: boolean;
    onProgress?: (ratio: number) => void;
  }
): Promise<string> {
  if (!input) throw new Error("Input path is required.");
  if (!keep || keep.length === 0) throw new Error("Keep list is empty.");

  const fd = fs.openSync(input, "r");
  const { chunks } = readChunks(fd);

  const fmtChunk = chunks.find(c => c.id === "fmt ");
  const dataChunk = chunks.find(c => c.id === "data");
  if (!fmtChunk || !dataChunk) throw new Error("Missing fmt or data chunk.");

  const fmtBuf = readChunkData(fd, fmtChunk);
  const fmt = parseFmt(fmtBuf);

  if (fmt.audioFormat !== 1) throw new Error(`Only PCM supported currently (audioFormat=${fmt.audioFormat}).`);

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (![2, 3, 4].includes(bytesPerSample)) throw new Error(`Unsupported bitsPerSample=${fmt.bitsPerSample}.`);

  const inputChannels = fmt.numChannels;
  const keepZeroBased = keep.map(k => k - 1);
  if (keepZeroBased.some(k => k < 0 || k >= inputChannels)) {
    throw new Error(`Keep indices out of range. File has ${inputChannels} channels.`);
  }

  const outDir = opts?.outDir ?? path.join(path.dirname(input), "output");
  fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, path.basename(input));
  const tmpPath = outPath + ".tmp";

  const outFd = fs.openSync(tmpPath, "w");
  let outPos = 0;

  function writeBuf(b: Buffer) {
    fs.writeSync(outFd, b, 0, b.length, outPos);
    outPos += b.length;
  }

  function writeRiffChunk(id: string, data: Buffer) {
    const head = Buffer.alloc(8);
    head.write(id, 0, 4, "ascii");
    head.writeUInt32LE(data.length, 4);
    writeBuf(head);
    writeBuf(data);
    if (data.length % 2 === 1) writeBuf(Buffer.from([0x00])); // padding
  }

  // Placeholder RIFF header (we fill sizes later)
  writeBuf(Buffer.from("RIFF", "ascii"));
  const riffSizePos = outPos;
  writeBuf(Buffer.alloc(4)); // size placeholder
  writeBuf(Buffer.from("WAVE", "ascii"));

  // Write chunks: copy all except fmt/data (we rebuild those)
  // iXML: patch if present
  const ixmlChunk = chunks.find(c => c.id === "iXML");
  const bextChunk = chunks.find(c => c.id === "bext");
  const chnaChunk = chunks.find(c => c.id === "chna");

  // fmt (rebuilt)
  const newFmt = buildFmt(fmt, keep.length);
  writeRiffChunk("fmt ", newFmt);

  // Write other chunks except data and fmt (and we handle iXML specially)
  for (const ch of chunks) {
    if (ch.id === "fmt " || ch.id === "data") continue;
    if (ch.id === "iXML") continue; // handled below
    if (ch.id === "chna") continue; // handled below
    const data = readChunkData(fd, ch);
    writeRiffChunk(ch.id, data);
  }

  // iXML (patched)
  if (ixmlChunk) {
    const ixml = readChunkData(fd, ixmlChunk);
    const patched = patchIXML(ixml, keep);
    writeRiffChunk("iXML", patched);
  }

  if (chnaChunk) {
    const chna = readChunkData(fd, chnaChunk);
    const patched = patchCHNA(chna, keep);
    writeRiffChunk("chna", patched);
  }

  // data (rebuilt by channel-picking)
  // We stream-read frames from input data and write reduced frames.
  writeBuf(Buffer.from("data", "ascii"));
  const dataSizePos = outPos;
  writeBuf(Buffer.alloc(4)); // data size placeholder

  const frameInBytes = fmt.blockAlign; // inputChannels * bytesPerSample
  const frameOutBytes = keep.length * bytesPerSample;

  const dataStart = dataChunk.dataOffset;
  const dataEnd = dataChunk.dataOffset + dataChunk.size;

  const readBufSize = 1024 * 1024; // 1MB
  let pos = dataStart;
  let outDataBytes = 0;
  let carry = Buffer.alloc(0);
  let processed = 0;
  let lastReport = 0;

  while (pos < dataEnd) {
    const remaining = dataEnd - pos;
    const toRead = Math.min(readBufSize, remaining);
    const buf = Buffer.alloc(toRead);
    fs.readSync(fd, buf, 0, toRead, pos);
    pos += toRead;
    processed += toRead;

    // Ensure we process whole frames only (carry remainder to next read)
    const combined = carry.length ? Buffer.concat([carry, buf]) : buf;
    const whole = Math.floor(combined.length / frameInBytes) * frameInBytes;
    const usable = combined.subarray(0, whole);
    carry = combined.subarray(whole);

    // For each frame, pick kept channels
    const out = Buffer.alloc((whole / frameInBytes) * frameOutBytes);
    let o = 0;

    for (let i = 0; i < usable.length; i += frameInBytes) {
      for (const chIdx of keepZeroBased) {
        const inOff = i + chIdx * bytesPerSample;
        usable.copy(out, o, inOff, inOff + bytesPerSample);
        o += bytesPerSample;
      }
    }

    writeBuf(out);
    outDataBytes += out.length;

    if (opts?.onProgress && (processed - lastReport >= 5 * 1024 * 1024 || pos >= dataEnd)) {
      lastReport = processed;
      opts.onProgress(Math.min(1, processed / dataChunk.size));
    }
  }

  if (carry.length !== 0) {
    console.warn(`Warning: ${carry.length} trailing bytes not aligned to frame size.`);
  }

  if (outDataBytes % 2 === 1) writeBuf(Buffer.from([0x00])); // padding

  fs.closeSync(fd);

  // Patch sizes: RIFF size and data size
  const riffSize = outPos - 8;
  const riffSizeBuf = Buffer.alloc(4);
  riffSizeBuf.writeUInt32LE(riffSize, 0);
  fs.writeSync(outFd, riffSizeBuf, 0, 4, riffSizePos);

  const dataSizeBuf = Buffer.alloc(4);
  dataSizeBuf.writeUInt32LE(outDataBytes, 0);
  fs.writeSync(outFd, dataSizeBuf, 0, 4, dataSizePos);

  fs.closeSync(outFd);

  fs.renameSync(tmpPath, outPath);

  if (opts?.validateWithBwfmetaedit) {
    // Optional: validate with bwfmetaedit if present
    // (This checks bext consistency etc.; it also reports presence of iXML)
    try {
      const { spawnSync } = await import("node:child_process");
      let r = spawnSync("bwfmetaedit", ["--check", outPath], { encoding: "utf8" });
      const out = (r.stdout || "") + (r.stderr || "");
      if (r.status !== 0 && /--check is unknown/i.test(out)) {
        r = spawnSync("bwfmetaedit", [outPath], { encoding: "utf8" });
      }

      if (r.status !== 0) {
        console.error("bwfmetaedit warnings/errors:\n", r.stdout || r.stderr);
      }
    } catch {
      // ignore
    }
  }

  return outPath;
}

async function main() {
  const input = process.argv[2];
  const keepArg = process.argv[3]; // e.g. "1,2,3,4,5,6"
  if (!input || !keepArg) {
    console.error('Usage: npm run dev -- "in.wav" "1,2,3"');
    process.exit(1);
  }

  const keep = keepArg.split(",").map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 1);
  const outPath = await trimWav(input, keep, { validateWithBwfmetaedit: true });
  console.log(`Wrote: ${outPath}`);
}

const isDirectRun = process.argv[1] && new URL(`file://${process.argv[1]}`).href === import.meta.url;

if (isDirectRun) {
  main().catch(err => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}
