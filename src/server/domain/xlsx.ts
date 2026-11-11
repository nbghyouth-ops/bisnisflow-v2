import readXlsxFile from "read-excel-file/node";
import { badRequest } from "@/server/base";

const MAX_XLSX_BYTES = 2 * 1024 * 1024;
const MAX_UNCOMPRESSED = 25 * 1024 * 1024; // zip-bomb guard
const MAX_ENTRIES = 200;

/** Reads the zip central directory and rejects archives whose declared uncompressed size is excessive (zip bomb). */
function assertSafeZip(buf: Buffer) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw badRequest("Berkas bukan XLSX yang valid");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw badRequest("Struktur XLSX tidak valid");
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  if (entries > MAX_ENTRIES) throw badRequest("XLSX memiliki terlalu banyak komponen");
  let total = 0;
  for (let n = 0; n < entries; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) throw badRequest("Struktur XLSX tidak valid");
    total += buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), commentLen = buf.readUInt16LE(off + 32);
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString("utf8");
    if (/vbaProject\.bin|macros\//i.test(name)) throw badRequest("Dokumen dengan makro ditolak");
    if (name.includes("..")) throw badRequest("Struktur XLSX tidak valid");
    off += 46 + nameLen + extraLen + commentLen;
  }
  if (total > MAX_UNCOMPRESSED) throw badRequest("Isi XLSX terlalu besar setelah diekstrak");
}

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

/** Parses the FIRST sheet of an .xlsx into a string grid with the same shape as parseCsv(). */
export async function parseXlsx(bytes: Buffer): Promise<string[][]> {
  if (bytes.length === 0 || bytes.length > MAX_XLSX_BYTES) throw badRequest("Berkas XLSX harus 1 byte – 2 MB");
  assertSafeZip(bytes);
  let sheet: unknown[][];
  try {
    sheet = (await readXlsxFile(bytes)) as unknown[][];
  } catch {
    throw badRequest("Berkas XLSX tidak dapat dibaca");
  }
  return sheet.map((r) => r.map(cellToString)).filter((r) => r.some((c) => c.trim() !== ""));
}
