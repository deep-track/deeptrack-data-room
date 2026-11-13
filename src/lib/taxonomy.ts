// The data room map from the Deeptrack Data Room User Guide (section 2).
// A document's `category` is stored as "Section / Folder".
// Keep in sync with backend/src/taxonomy.ts.
export type Folder = { name: string; holds: string };
export type Section = { name: string; folders: Folder[] };

export const SECTIONS: Section[] = [
  { name: "Corporate & Governance", folders: [
    { name: "Incorporation & Charter", holds: "Certificate of incorporation, memorandum & articles, good standing certificate." },
    { name: "Board & Resolutions", holds: "Round-authorization resolutions, board minutes, committee charters." },
    { name: "Cap Table & Shareholders", holds: "Fully diluted cap table, shareholder register, prior-round SAFEs." },
    { name: "Organizational Structure", holds: "Entity chart, subsidiary register." },
  ] },
  { name: "Financials", folders: [
    { name: "Financial Statements", holds: "Audited statements, management accounts, balance sheet summary." },
    { name: "Projections & Modeling", holds: "Three-year model, key metrics dashboard, use of funds." },
    { name: "Tax & Statutory", holds: "Tax compliance certificate, VAT filings." },
    { name: "Banking", holds: "Bank statements, debt schedule." },
  ] },
  { name: "Legal & Compliance", folders: [
    { name: "Material Contracts", holds: "MSA template, top customer contracts, vendor agreements." },
    { name: "Litigation & Disputes", holds: "Litigation disclosure statement, historical dispute summary." },
    { name: "Regulatory & Licenses", holds: "Data protection registration, operating licenses." },
    { name: "Data Protection & Privacy", holds: "Privacy policy, DPA template, DPIA." },
  ] },
  { name: "Intellectual Property & Technology", folders: [
    { name: "IP Assets", holds: "Trademark registrations, IP assignment agreements." },
    { name: "Security & Certifications", holds: "SOC 2 report, ISO 27001 certificate, pen-test report." },
    { name: "Architecture & Documentation", holds: "System architecture overview, infrastructure/hosting summary." },
    { name: "Third-Party & Open Source", holds: "OSS inventory, license compliance summary." },
  ] },
  { name: "Commercial & Market", folders: [
    { name: "Customers & Revenue", holds: "Customer list & ARR breakdown, public logo reference list." },
    { name: "Partnerships", holds: "Strategic partnership agreements." },
    { name: "Market & Competitive", holds: "TAM/SAM/SOM analysis, competitive landscape." },
    { name: "Sales Pipeline", holds: "Current pipeline summary." },
  ] },
  { name: "Human Resources", folders: [
    { name: "Team & Org Chart", holds: "Headcount summary, leadership bios." },
    { name: "Key Employment Agreements", holds: "Founder agreements, key employee retention terms." },
    { name: "Equity Incentive Plan", holds: "ESOP plan document, option grant summary." },
    { name: "Policies & Handbook", holds: "Employee handbook, code of conduct." },
  ] },
  { name: "Risk & Security", folders: [
    { name: "Risk Management", holds: "Enterprise risk register, business continuity plan." },
    { name: "Incident Response", holds: "Incident response plan, historical incident log." },
    { name: "Insurance", holds: "Cyber insurance policy, general liability & D&O." },
  ] },
  { name: "Fundraising & Deal Documents", folders: [
    { name: "Pitch Materials", holds: "Investor pitch deck, one-pager / executive summary." },
    { name: "Deal Terms", holds: "Term sheet, SAFE / convertible note template." },
    { name: "Diligence Checklist", holds: "Master index of the room and suggested diligence checklist." },
  ] },
];

export const folderKey = (section: string, folder: string) => `${section} / ${folder}`;
export const ALL_FOLDERS = SECTIONS.flatMap((s) => s.folders.map((f) => ({ section: s.name, ...f, key: folderKey(s.name, f.name) })));

// Documents filed before the guide used five flat folders; show them in the matching place.
const LEGACY: Record<string, string> = {
  "Fundraise materials": folderKey("Fundraising & Deal Documents", "Pitch Materials"),
  "Financials": folderKey("Financials", "Financial Statements"),
  "Technology": folderKey("Intellectual Property & Technology", "Architecture & Documentation"),
  "Legal": folderKey("Legal & Compliance", "Material Contracts"),
  "Governance": folderKey("Corporate & Governance", "Board & Resolutions"),
};
export function placeOf(category: string) {
  const key = LEGACY[category] ?? category;
  const found = ALL_FOLDERS.find((f) => f.key === key);
  return found ? { section: found.section, folder: found.name, key } : { section: "Other", folder: category, key: category };
}

export const TIERS = [
  { tier: 1 as const, name: "General", who: "Any investor with access", use: "Pitch deck, market sizing, public-facing policies." },
  { tier: 2 as const, name: "Diligence", who: "Investors upgraded for diligence", use: "Financials, contracts, certifications." },
  { tier: 3 as const, name: "Restricted", who: "Founder and Chief of Staff only", use: "Cap table, board minutes, customer-level revenue." },
];

export const MAX_UPLOAD_MB = 10;
