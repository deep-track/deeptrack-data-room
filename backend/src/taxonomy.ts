// Folder keys ("Section / Folder") from the Deeptrack Data Room User Guide.
// Keep in sync with src/lib/taxonomy.ts (the web app also shows what goes in each).
export const FOLDER_KEYS = [
  "Corporate & Governance / Incorporation & Charter",
  "Corporate & Governance / Board & Resolutions",
  "Corporate & Governance / Cap Table & Shareholders",
  "Corporate & Governance / Organizational Structure",
  "Financials / Financial Statements",
  "Financials / Projections & Modeling",
  "Financials / Tax & Statutory",
  "Financials / Banking",
  "Legal & Compliance / Material Contracts",
  "Legal & Compliance / Litigation & Disputes",
  "Legal & Compliance / Regulatory & Licenses",
  "Legal & Compliance / Data Protection & Privacy",
  "Intellectual Property & Technology / IP Assets",
  "Intellectual Property & Technology / Security & Certifications",
  "Intellectual Property & Technology / Architecture & Documentation",
  "Intellectual Property & Technology / Third-Party & Open Source",
  "Commercial & Market / Customers & Revenue",
  "Commercial & Market / Partnerships",
  "Commercial & Market / Market & Competitive",
  "Commercial & Market / Sales Pipeline",
  "Human Resources / Team & Org Chart",
  "Human Resources / Key Employment Agreements",
  "Human Resources / Equity Incentive Plan",
  "Human Resources / Policies & Handbook",
  "Risk & Security / Risk Management",
  "Risk & Security / Incident Response",
  "Risk & Security / Insurance",
  "Fundraising & Deal Documents / Pitch Materials",
  "Fundraising & Deal Documents / Deal Terms",
  "Fundraising & Deal Documents / Diligence Checklist",
] as const;

export const isFolder = (value: string) => (FOLDER_KEYS as readonly string[]).includes(value);
export const isVersionLabel = (value: string) => /^\d{1,3}(\.\d{1,3}){0,2}$/.test(value);
