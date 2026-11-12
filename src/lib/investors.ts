import { authorizedRequest } from "./repository";
import { excelDate, readWorkbook, type Cell } from "./xlsx";

export type Investor = {
  id: string; ref: string | null; name: string; type: string | null; stageFocus: string | null; sectorFocus: string | null;
  geography: string | null; website: string | null; contactName: string | null; contactTitle: string | null; email: string | null;
  phone: string | null; linkedin: string | null; warmIntroSource: string | null; owner: string | null; fundSizeM: number | null;
  typicalCheckK: number | null; status: string; priority: string | null; lastContact: string | null; nextAction: string | null;
  nextFollowUp: string | null; interest: string | null; round: string | null; amountTargetK: number | null;
  dataRoomShared: string | null; deckSent: string | null; ndaSigned: string | null; meeting1: string | null; meeting2: string | null;
  dueDiligence: string | null; decision: string | null; probability: number | null; expectedClose: string | null;
  notes: string | null; introAngle: string | null; createdAt: string; updatedAt: string;
};
export type InvestorInput = Partial<Omit<Investor, "id" | "createdAt" | "updatedAt">>;
export type InvestorOptions = { statuses: string[]; priorities: string[]; interest: string[]; yesNo: string[] };
export type InvestorActivity = { id: string; kind: string; summary: string; actor: string | null; at: string };
export type ImportResult = { created: number; skipped: number; createdNames: string[]; skippedNames: string[] };

export const investorApi = {
  list: () => authorizedRequest<{ investors: Investor[]; options: InvestorOptions }>("/investors"),
  get: (id: string) => authorizedRequest<{ investor: Investor; activity: InvestorActivity[] }>(`/investors/${encodeURIComponent(id)}`),
  create: (input: InvestorInput) => authorizedRequest<Investor>("/investors", { method: "POST", body: JSON.stringify(input) }),
  update: (id: string, input: InvestorInput) => authorizedRequest<{ investor: Investor; activity: InvestorActivity[]; changes: string[] }>(`/investors/${encodeURIComponent(id)}`, { method: "POST", body: JSON.stringify(input) }),
  logActivity: (id: string, input: { kind: string; summary: string; date?: string }) => authorizedRequest<{ investor: Investor; activity: InvestorActivity[] }>(`/investors/${encodeURIComponent(id)}/activity`, { method: "POST", body: JSON.stringify(input) }),
  import: (rows: InvestorInput[]) => authorizedRequest<ImportResult>("/investors/import", { method: "POST", body: JSON.stringify({ rows }) }),
};

// Spreadsheet column header → field. Matches the "Investor_CRM" sheet of the
// Deeptrack Fundraising CRM template; headers are matched case-insensitively.
const COLUMNS: Record<string, { field: keyof InvestorInput; kind?: "date" | "number" | "percent" }> = {
  "investor id": { field: "ref" }, "investor/fund": { field: "name" }, "type": { field: "type" }, "stage focus": { field: "stageFocus" },
  "sector focus": { field: "sectorFocus" }, "geography": { field: "geography" }, "website": { field: "website" },
  "partner/contact": { field: "contactName" }, "title": { field: "contactTitle" }, "email": { field: "email" }, "phone": { field: "phone" },
  "linkedin": { field: "linkedin" }, "warm intro source": { field: "warmIntroSource" }, "relationship owner": { field: "owner" },
  "fund size ($m)": { field: "fundSizeM", kind: "number" }, "typical check ($k)": { field: "typicalCheckK", kind: "number" },
  "current status": { field: "status" }, "priority": { field: "priority" }, "last contact": { field: "lastContact", kind: "date" },
  "next action": { field: "nextAction" }, "next follow-up": { field: "nextFollowUp", kind: "date" }, "interest level": { field: "interest" },
  "fundraising round": { field: "round" }, "amount target ($k)": { field: "amountTargetK", kind: "number" },
  "data room shared": { field: "dataRoomShared" }, "pitch deck sent": { field: "deckSent" }, "nda signed": { field: "ndaSigned" },
  "meeting 1": { field: "meeting1", kind: "date" }, "meeting 2": { field: "meeting2", kind: "date" }, "due diligence": { field: "dueDiligence" },
  "decision": { field: "decision" }, "investment probability %": { field: "probability", kind: "percent" },
  "expected close": { field: "expectedClose", kind: "date" }, "notes": { field: "notes" },
  "portfolio overlap / warm-intro angle": { field: "introAngle" },
};

function normalise(header: Cell) { return String(header ?? "").trim().toLowerCase().replace(/\s+/g, " "); }

export async function investorsFromSpreadsheet(file: File): Promise<{ sheet: string; rows: InvestorInput[] }> {
  const sheets = await readWorkbook(file);
  for (const [name, grid] of sheets) {
    const headerRow = grid.findIndex((row) => row.some((cell) => normalise(cell) === "investor/fund"));
    if (headerRow < 0) continue;
    const headers = grid[headerRow].map((cell) => COLUMNS[normalise(cell)]);
    const rows: InvestorInput[] = [];
    for (const line of grid.slice(headerRow + 1)) {
      const row: Record<string, unknown> = {};
      headers.forEach((column, index) => {
        if (!column) return;
        const cell = line[index] ?? null;
        if (cell === null || cell === "") return;
        if (column.kind === "date") { const date = excelDate(cell); if (date) row[column.field] = date; return; }
        if (column.kind === "number" || column.kind === "percent") { const n = typeof cell === "number" ? cell : Number(String(cell).replace(/[,%$\s]/g, "")); if (Number.isFinite(n)) row[column.field] = n; return; }
        row[column.field] = typeof cell === "string" ? cell.trim() : String(cell);
      });
      if (typeof row.name === "string" && row.name) rows.push(row as InvestorInput);
    }
    // Probability may be stored as a fraction (0.25 shown as 25%) or a whole number.
    const fractions = rows.every((row) => row.probability == null || row.probability <= 1);
    if (fractions) for (const row of rows) if (row.probability != null) row.probability = Math.round(row.probability * 100);
    return { sheet: name, rows };
  }
  throw new Error("No investor list was found. The file needs a sheet with an \"Investor/Fund\" column, like the Fundraising CRM template.");
}
