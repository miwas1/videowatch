import { deflateRawSync } from "node:zlib";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const extensionDist = resolve(repoRoot, "apps/extension/dist");
const outputPath = resolve(repoRoot, "apps/web/public/downloads/describeops-extension.zip");

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      if (entry.isFile()) return [path];
      return [];
    })
    .sort((a, b) => a.localeCompare(b));
}

function localFileHeader(entry) {
  return Buffer.concat([
    uint32(0x04034b50),
    uint16(20),
    uint16(0),
    uint16(8),
    uint16(entry.dosTime),
    uint16(entry.dosDate),
    uint32(entry.crc),
    uint32(entry.compressedSize),
    uint32(entry.uncompressedSize),
    uint16(entry.name.length),
    uint16(0),
    entry.name,
  ]);
}

function centralDirectoryHeader(entry) {
  return Buffer.concat([
    uint32(0x02014b50),
    uint16(20),
    uint16(20),
    uint16(0),
    uint16(8),
    uint16(entry.dosTime),
    uint16(entry.dosDate),
    uint32(entry.crc),
    uint32(entry.compressedSize),
    uint32(entry.uncompressedSize),
    uint16(entry.name.length),
    uint16(0),
    uint16(0),
    uint16(0),
    uint16(0),
    uint32(0),
    uint32(entry.offset),
    entry.name,
  ]);
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  return Buffer.concat([
    uint32(0x06054b50),
    uint16(0),
    uint16(0),
    uint16(entryCount),
    uint16(entryCount),
    uint32(centralSize),
    uint32(centralOffset),
    uint16(0),
  ]);
}

function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const raw = readFileSync(file);
    const compressed = deflateRawSync(raw, { level: 9 });
    const stat = statSync(file);
    const relativeName = relative(extensionDist, file).split(sep).join("/");
    const { dosDate, dosTime } = dosDateTime(stat.mtime);
    const entry = {
      name: Buffer.from(relativeName),
      dosDate,
      dosTime,
      crc: crc32(raw),
      compressedSize: compressed.length,
      uncompressedSize: raw.length,
      offset,
    };

    const header = localFileHeader(entry);
    localParts.push(header, compressed);
    offset += header.length + compressed.length;
    centralParts.push(centralDirectoryHeader(entry));
  }

  const centralOffset = offset;
  const central = Buffer.concat(centralParts);
  return Buffer.concat([
    ...localParts,
    central,
    endOfCentralDirectory(files.length, central.length, centralOffset),
  ]);
}

const files = listFiles(extensionDist);
if (!files.length) {
  throw new Error(`No extension build files found in ${extensionDist}. Run npm run build:extension first.`);
}

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, buildZip(files));
console.log(`Packaged ${files.length} extension files into ${relative(repoRoot, outputPath)} (${basename(outputPath)})`);
