// Minimal .xlsx reader for the investor import. Runs entirely in the browser:
// the spreadsheet never leaves the device; only the parsed rows go to the API.
// Reads cell values (including cached results of formulas), not styles.

export type Cell = string | number | boolean | null;
export type Sheet = Cell[][];

const MAX_BYTES = 10 * 1024 * 1024;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(buffer: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let eocd = -1;
  for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65_557); i--) if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("This file is not a valid .xlsx spreadsheet.");
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const files = new Map<string, () => Promise<string>>();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("This spreadsheet is damaged.");
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
    files.set(name, async () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + compressed);
      if (method === 0) return decoder.decode(raw);
      if (method === 8) return decoder.decode(await inflateRaw(raw));
      throw new Error("This spreadsheet uses an unsupported compression method.");
    });
  }
  return files;
}

function decode(text: string) {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "lt") return "<"; if (lower === "gt") return ">"; if (lower === "amp") return "&"; if (lower === "quot") return '"'; if (lower === "apos") return "'";
    return String.fromCodePoint(lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10));
  });
}
function textOf(xml: string) { return decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join("")); }
function attr(tag: string, name: string) { return tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1]; }
function columnIndex(ref: string) { let n = 0; for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; }

export async function readWorkbook(file: File): Promise<Map<string, Sheet>> {
  if (file.size > MAX_BYTES) throw new Error("This spreadsheet is larger than 10 MB.");
  if (typeof DecompressionStream === "undefined") throw new Error("This browser can't read spreadsheets. Use a current version of Chrome, Edge, Safari or Firefox.");
  const files = await unzip(await file.arrayBuffer());
  const read = async (path: string) => { const entry = files.get(path); return entry ? entry() : undefined; };
  const workbook = await read("xl/workbook.xml");
  const rels = await read("xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) throw new Error("This file is not a valid .xlsx spreadsheet.");
  const shared = [...((await read("xl/sharedStrings.xml")) ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [attr(m[0], "Id") ?? "", (attr(m[0], "Target") ?? "").replace(/^\/?(xl\/)?/, "xl/")]));
  const sheets = new Map<string, Sheet>();
  for (const match of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = decode(attr(match[0], "name") ?? "");
    const target = targets.get(attr(match[0], "r:id") ?? "");
    const xml = target ? await read(target) : undefined;
    if (!xml) continue;
    const grid: Sheet = [];
    for (const row of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
      const r = Number(attr(row[0], "r")) - 1;
      const cells: Cell[] = [];
      for (const cell of row[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(`<c${cell[1]}`, "r"); const type = attr(`<c${cell[1]}`, "t"); const body = cell[2] ?? "";
        const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value: Cell = null;
        if (type === "s" && raw !== undefined) value = shared[Number(raw)] ?? null;
        else if (type === "inlineStr") value = textOf(body);
        else if (type === "str" || type === "e") value = raw !== undefined ? decode(raw) : null;
        else if (type === "b") value = raw === "1";
        else if (raw !== undefined && raw !== "") value = Number(raw);
        cells[ref ? columnIndex(ref) : cells.length] = value;
      }
      grid[r] = Array.from(cells, (v) => v ?? null);
    }
    sheets.set(name, Array.from(grid, (row) => row ?? []));
  }
  return sheets;
}

/** Excel stores dates as days since 1899-12-30. */
export function excelDate(value: Cell): string | null {
  if (typeof value === "number" && value > 20000 && value < 80000) return new Date(Math.round((value - 25569) * 86400000)).toISOString().slice(0, 10);
  if (typeof value === "string") {
    const text = value.trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
    const parsed = Date.parse(text);
    if (text && !Number.isNaN(parsed)) return new Date(parsed - new Date(parsed).getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  }
  return null;
}
