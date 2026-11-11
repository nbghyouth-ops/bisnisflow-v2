import PDFDocument from "pdfkit";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
const MAX_ROWS = 2000;
const MAX_COLS = 8;

const label = (k: string) => k.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
const cell = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const isNumeric = (v: string) => /^-?\d+(\.\d+)?$/.test(v);

/** Renders any report JSON (sections of key/values and tables) into an A4 PDF. No external browser required. */
export function renderReportPdf(opts: { title: string; subtitle: string; workspace: string; data: Record<string, unknown> }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: opts.title, Author: "Business Flow" } });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;

    doc.font("Helvetica-Bold").fontSize(16).text(opts.title);
    doc.font("Helvetica").fontSize(9).fillColor("#555").text(`${opts.workspace} · ${opts.subtitle}`).moveDown(0.8).fillColor("#000");

    function table(name: string, rowsIn: Record<string, unknown>[]) {
      const rowsCut = rowsIn.slice(0, MAX_ROWS);
      const cols = [...new Set(rowsCut.flatMap((r) => Object.keys(r)))].slice(0, MAX_COLS);
      if (!cols.length) return;
      doc.font("Helvetica-Bold").fontSize(11).text(label(name)).moveDown(0.2);
      const cw = width / cols.length;
      const drawRow = (vals: string[], bold: boolean, shade: boolean) => {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
        const h = Math.max(...vals.map((v) => doc.heightOfString(v, { width: cw - 6 }))) + 6;
        if (doc.y + h > bottom()) doc.addPage();
        const y = doc.y;
        if (shade) doc.rect(left, y, width, h).fill("#eef1f5").fillColor("#000");
        vals.forEach((v, i) => doc.text(v, left + i * cw + 3, y + 3, { width: cw - 6, align: isNumeric(v) && !bold ? "right" : "left" }));
        doc.x = left; doc.y = y + h;
      };
      drawRow(cols.map(label), true, true);
      for (const r of rowsCut) drawRow(cols.map((c) => cell(r[c])), false, false);
      if (rowsIn.length > MAX_ROWS) doc.font("Helvetica-Oblique").fontSize(8).text(`… ${rowsIn.length - MAX_ROWS} baris tidak ditampilkan. Gunakan ekspor CSV untuk data lengkap.`);
      doc.moveDown(0.8);
    }

    function walk(name: string, v: Json | unknown, depth: number) {
      if (Array.isArray(v)) {
        if (v.length && v.every((x) => x && typeof x === "object" && !Array.isArray(x))) table(name, v as Record<string, unknown>[]);
        else if (v.length) doc.font("Helvetica").fontSize(9).text(`${label(name)}: ${v.map(cell).join(", ")}`);
        else doc.font("Helvetica-Oblique").fontSize(9).fillColor("#555").text(`${label(name)}: (kosong)`).fillColor("#000");
      } else if (v && typeof v === "object") {
        doc.font("Helvetica-Bold").fontSize(depth ? 10 : 11).text(label(name)).moveDown(0.2);
        for (const [k, x] of Object.entries(v)) walk(k, x, depth + 1);
        doc.moveDown(0.3);
      } else {
        doc.font("Helvetica").fontSize(9).text(`${label(name)}: ${cell(v)}`);
      }
    }
    for (const [k, v] of Object.entries(opts.data)) walk(k, v, 0);

    const range = doc.bufferedPageRange();
    void range;
    doc.end();
  });
}
