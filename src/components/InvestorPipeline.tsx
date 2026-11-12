import { CalendarClock, FileSpreadsheet, Plus, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { investorApi, investorsFromSpreadsheet, type ImportResult, type Investor, type InvestorActivity, type InvestorInput, type InvestorOptions } from "../lib/investors";

const ACTIVE_ORDER = ["Prospect Identified", "Research Complete", "Warm Intro Requested", "Outreach Sent", "Reply Received", "Intro Call Scheduled", "Intro Call Complete", "Pitch Deck Sent", "Pitch Meeting Scheduled", "Pitch Meeting Complete", "Partner Meeting", "Due Diligence", "Term Sheet Received", "Closed Won"];
const CLOSED = ["Closed Won", "Closed Lost", "Passed"];
const AFRICA = /africa|nairobi|kenya|lagos|nigeria|ghana|accra|kigali|rwanda|dakar|senegal|cairo|egypt|johannesburg|cape town|south africa|uganda|tanzania|ethiopia|morocco|pan-african/i;
type Filter = "all" | "high" | "africa" | "due";
const FILTERS: [Filter, string][] = [["all", "All"], ["high", "High priority"], ["africa", "Africa"], ["due", "Follow-up due"]];
const PRIORITY_RANK: Record<string, number> = { High: 0, Medium: 1, Low: 2 };

function today() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function addDays(iso: string, days: number) { const d = new Date(`${iso}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function shortDate(iso: string | null) { return iso ? new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso.slice(0, 10)}T12:00:00Z`)) : "—"; }
function when(iso: string) { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)); }
function sentence(status: string) { return status.charAt(0) + status.slice(1).toLowerCase(); }
function isOpen(investor: Investor) { return !CLOSED.includes(investor.status); }
function followUpDue(investor: Investor, horizon: string) { return isOpen(investor) && !!investor.nextFollowUp && investor.nextFollowUp <= horizon; }
function subtitle(investor: Investor) { return [investor.type, investor.stageFocus, investor.geography].filter(Boolean).join(" · ") || "No details yet"; }
function hostOf(url: string | null) { try { return url ? new URL(url).host.replace(/^www\./, "") : null; } catch { return url; } }
function message(cause: unknown, fallback: string) { return cause instanceof Error ? cause.message : fallback; }

export function InvestorPipeline() {
  const [investors, setInvestors] = useState<Investor[]>([]);
  const [options, setOptions] = useState<InvestorOptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ fileName: string; sheet: string; rows: InvestorInput[] } | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh() {
    try { const result = await investorApi.list(); setInvestors(result.investors); setOptions(result.options); setError(""); }
    catch (cause) { setError(message(cause, "The investor pipeline could not be loaded.")); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);

  const now = today(); const horizon = addDays(now, 7);
  const sorted = useMemo(() => [...investors].sort((a, b) =>
    (PRIORITY_RANK[a.priority ?? ""] ?? 3) - (PRIORITY_RANK[b.priority ?? ""] ?? 3)
    || (a.nextFollowUp ?? "9999").localeCompare(b.nextFollowUp ?? "9999")
    || a.name.localeCompare(b.name)), [investors]);
  const visible = useMemo(() => sorted.filter((investor) => {
    if (filter === "high" && investor.priority !== "High") return false;
    if (filter === "africa" && !AFRICA.test(`${investor.geography ?? ""} ${investor.sectorFocus ?? ""} ${investor.name}`)) return false;
    if (filter === "due" && !followUpDue(investor, horizon)) return false;
    const haystack = `${investor.name} ${investor.ref ?? ""} ${investor.type ?? ""} ${investor.geography ?? ""} ${investor.contactName ?? ""} ${investor.email ?? ""} ${investor.owner ?? ""} ${investor.status}`.toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  }), [sorted, filter, query, horizon]);

  const engagedFrom = ACTIVE_ORDER.indexOf("Reply Received");
  const engaged = investors.filter((i) => { const at = ACTIVE_ORDER.indexOf(i.status); return at >= engagedFrom && i.status !== "Closed Won"; }).length;
  const high = investors.filter((i) => i.priority === "High" && isOpen(i));
  const due = investors.filter((i) => followUpDue(i, horizon));
  const overdue = due.filter((i) => (i.nextFollowUp ?? "") < now).length;
  const typeCounts = Object.entries(investors.reduce<Record<string, number>>((acc, i) => { const key = i.type || "Unspecified"; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {})).sort((a, b) => b[1] - a[1]);
  const offFunnel = investors.filter((i) => !ACTIVE_ORDER.includes(i.status));

  async function chooseFile(file: File | undefined) {
    if (!file) return;
    setError(""); setImportResult(null);
    try { const parsed = await investorsFromSpreadsheet(file); setPendingImport({ fileName: file.name, ...parsed }); }
    catch (cause) { setError(message(cause, "The spreadsheet could not be read.")); }
    finally { if (fileInput.current) fileInput.current.value = ""; }
  }
  async function confirmImport() {
    if (!pendingImport) return;
    try { const result = await investorApi.import(pendingImport.rows); setImportResult(result); setPendingImport(null); await refresh(); }
    catch (cause) { setError(message(cause, "The import did not complete.")); setPendingImport(null); }
  }

  const selected = investors.find((i) => i.id === selectedId) ?? null;
  return <>
    <div className="workspace-head">
      <div><p className="eyebrow">Fundraising</p><h2>Investor pipeline</h2><p className="subcopy">Every investor you're talking to, where they stand, and what happens next.</p></div>
      <div className="pipeline-actions">
        <label className="search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search investors" aria-label="Search investors" /></label>
        <button className="secondary-button" onClick={() => fileInput.current?.click()}><FileSpreadsheet size={16} /> Import spreadsheet</button>
        <button className="primary-button" onClick={() => setAdding(true)}><Plus size={16} /> Add investor</button>
        <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="visually-hidden" onChange={(event) => void chooseFile(event.target.files?.[0])} />
      </div>
    </div>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}
    {importResult && <div className="error-banner success-banner" role="status"><span>Imported {importResult.created} investor{importResult.created === 1 ? "" : "s"}{importResult.skipped ? `. Skipped ${importResult.skipped} already in the pipeline: ${importResult.skippedNames.join(", ")}` : ""}.</span><button type="button" onClick={() => setImportResult(null)} aria-label="Dismiss"><X size={16} /></button></div>}
    <section className="metrics metrics-4" aria-label="Pipeline overview">
      <article><span>Investors tracked</span><strong>{investors.length}</strong><p>{typeCounts.slice(0, 2).map(([type, n]) => `${n} ${type}`).join(" · ") || "None yet"}</p></article>
      <article><span>Engaged</span><strong>{engaged}</strong><p>Replied or further</p></article>
      <article><span>High priority</span><strong>{high.length}</strong><p>{high.filter((i) => AFRICA.test(`${i.geography ?? ""} ${i.sectorFocus ?? ""}`)).length} Africa-focused</p></article>
      <article><span>Follow-ups due</span><strong>{due.length}</strong><p>{overdue ? `${overdue} overdue · ` : ""}Next 7 days</p></article>
    </section>
    <div className="funnel" aria-label="Investors by stage">
      {ACTIVE_ORDER.map((status) => { const n = investors.filter((i) => i.status === status).length; return <div key={status} className={n ? "has" : ""} title={status}><b>{n}</b><span>{sentence(status)}</span></div>; })}
    </div>
    {offFunnel.length > 0 && <p className="funnel-note">{["Closed Lost", "Passed", "On Hold"].map((s) => [s, offFunnel.filter((i) => i.status === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${n} ${s.toLowerCase()}`).join(" · ")}</p>}
    <section className="document-panel">
      <div className="table-head"><div><h3>Investors</h3><p>{loading ? "Loading…" : `${visible.length} of ${investors.length} investor${investors.length === 1 ? "" : "s"} · sorted by priority, then next follow-up`}</p></div><div className="chips">{FILTERS.map(([key, label]) => <button key={key} className={`chip ${filter === key ? "on" : ""}`} onClick={() => setFilter(key)}>{label}</button>)}</div></div>
      {loading ? <div className="empty-state">Loading investors…</div> : investors.length === 0 ? <div className="empty-state"><FileSpreadsheet size={28} /><h3>No investors yet</h3><p>Import your Fundraising CRM spreadsheet, or add investors one at a time.</p><button className="primary-button" onClick={() => fileInput.current?.click()}><FileSpreadsheet size={16} /> Import spreadsheet</button></div> : visible.length === 0 ? <div className="empty-state"><h3>No investors match this view</h3></div> :
        <div className="investor-table">
          <div className="investor-heading"><span>Investor</span><span>Stage</span><span>Priority</span><span>Interest</span><span>Next action</span><span>Prob.</span></div>
          {visible.map((investor) => <button key={investor.id} className={`investor-row ${selectedId === investor.id ? "selected" : ""}`} onClick={() => setSelectedId(investor.id)}>
            <span className="investor-name"><strong>{investor.name}</strong><small>{subtitle(investor)}</small></span>
            <span className="stage-pill">{sentence(investor.status)}</span>
            <span className={`priority priority-${(investor.priority ?? "none").toLowerCase()}`}>{investor.priority ?? "—"}</span>
            <span className="dim">{investor.interest ?? "—"}</span>
            <span className="next-action">{investor.nextAction ?? "—"}{investor.nextFollowUp && <small className={followUpDue(investor, now) ? "overdue" : ""}><CalendarClock size={12} /> {shortDate(investor.nextFollowUp)}</small>}</span>
            <span className="mono">{investor.probability ?? 0}%</span>
          </button>)}
        </div>}
    </section>
    {selected && options && <InvestorDrawer key={selected.id} investor={selected} options={options} onClose={() => setSelectedId(null)} onSaved={(next) => setInvestors((list) => list.map((i) => i.id === next.id ? next : i))} />}
    {adding && options && <AddInvestorDialog options={options} onClose={() => setAdding(false)} onCreated={(investor) => { setInvestors((list) => [...list, investor]); setAdding(false); setSelectedId(investor.id); }} />}
    {pendingImport && <div className="modal-backdrop" role="presentation"><section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title"><header><div><p className="eyebrow">Import spreadsheet</p><h2 id="import-title">Import {pendingImport.rows.length} investor{pendingImport.rows.length === 1 ? "" : "s"}?</h2></div><button className="icon-button" onClick={() => setPendingImport(null)} aria-label="Close"><X size={18} /></button></header>
      <p className="subcopy">From the “{pendingImport.sheet}” sheet of {pendingImport.fileName}. The file is read in your browser; only these rows are sent. Investors already in the pipeline (same ID or name) are skipped, so nothing is overwritten.</p>
      <ul className="import-list">{pendingImport.rows.slice(0, 50).map((row, i) => <li key={i}><strong>{row.ref ? `${row.ref} · ` : ""}{row.name}</strong><span>{[row.status, row.priority].filter(Boolean).join(" · ")}</span></li>)}{pendingImport.rows.length > 50 && <li>…and {pendingImport.rows.length - 50} more</li>}</ul>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setPendingImport(null)}>Cancel</button><button className="primary-button" onClick={() => void confirmImport()} disabled={!pendingImport.rows.length}>Import</button></div></section></div>}
  </>;
}

const EDITABLE = ["status", "priority", "interest", "probability", "nextAction", "nextFollowUp", "owner", "contactName", "contactTitle", "email", "phone", "website", "linkedin", "amountTargetK", "deckSent", "ndaSigned", "dataRoomShared", "dueDiligence", "notes", "introAngle"] as const;
type Editable = typeof EDITABLE[number];
type Draft = Record<Editable, string>;
const NUMERIC: Editable[] = ["probability", "amountTargetK"];
function draftOf(investor: Investor): Draft { return Object.fromEntries(EDITABLE.map((key) => [key, investor[key] == null ? "" : String(investor[key])])) as Draft; }

function InvestorDrawer({ investor, options, onClose, onSaved }: { investor: Investor; options: InvestorOptions; onClose: () => void; onSaved: (investor: Investor) => void }) {
  const [draft, setDraft] = useState<Draft>(() => draftOf(investor));
  const [activity, setActivity] = useState<InvestorActivity[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [logging, setLogging] = useState(false);
  useEffect(() => { investorApi.get(investor.id).then((r) => setActivity(r.activity)).catch((cause) => setError(message(cause, "History could not be loaded."))); }, [investor.id]);
  useEffect(() => { const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);

  const original = draftOf(investor);
  const changed = EDITABLE.filter((key) => draft[key].trim() !== original[key].trim());
  const set = (key: Editable) => (event: { target: { value: string } }) => setDraft((d) => ({ ...d, [key]: event.target.value }));
  const toggle = (key: Editable) => setDraft((d) => ({ ...d, [key]: d[key] === "Yes" ? "No" : "Yes" }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!changed.length) return;
    setSaving(true); setError(""); setNotice("");
    const input: Record<string, string | number | null> = {};
    for (const key of changed) { const value = draft[key].trim(); input[key] = value === "" ? null : NUMERIC.includes(key) ? Number(value) : value; }
    try { const result = await investorApi.update(investor.id, input as InvestorInput); onSaved(result.investor); setActivity(result.activity); setNotice(result.changes.length ? "Saved." : "No changes."); }
    catch (cause) { setError(message(cause, "Changes could not be saved.")); }
    finally { setSaving(false); }
  }

  const select = (key: Editable, values: string[], label: string) => <label className="field">{label}<select value={draft[key]} onChange={set(key)}>{draft[key] === "" && <option value="">—</option>}{values.map((v) => <option key={v} value={v}>{key === "status" ? sentence(v) : v}</option>)}</select></label>;
  const input = (key: Editable, label: string, type = "text", extra: Record<string, string> = {}) => <label className="field">{label}<input type={type} value={draft[key]} onChange={set(key)} {...extra} /></label>;
  return <aside className="drawer investor-drawer" role="dialog" aria-modal="true" aria-labelledby="investor-title">
    <button className="drawer-close" onClick={onClose}><X size={18} /> Close</button>
    <p className="eyebrow">{[investor.ref, investor.type].filter(Boolean).join(" · ")}</p>
    <h2 id="investor-title">{investor.name}</h2>
    <p className="drawer-sub">{[investor.stageFocus, investor.sectorFocus, investor.geography, hostOf(investor.website)].filter(Boolean).join(" · ")}</p>
    <form onSubmit={save}>
      {select("status", options.statuses, "Stage")}
      <div className="field-row three">{select("priority", options.priorities, "Priority")}{select("interest", options.interest, "Interest")}{input("probability", "Probability %", "number", { min: "0", max: "100", step: "1" })}</div>
      <label className="field">Next action<textarea rows={2} value={draft.nextAction} onChange={set("nextAction")} /></label>
      <div className="field-row">{input("nextFollowUp", "Follow-up date", "date")}{input("owner", "Owner")}</div>
      <div className="field-row">{input("contactName", "Partner / contact")}{input("contactTitle", "Title")}</div>
      <div className="field-row">{input("email", "Email", "email")}{input("phone", "Phone", "tel")}</div>
      <div className="field-row">{input("website", "Website")}{input("amountTargetK", "Amount target ($K)", "number", { min: "0", step: "any" })}</div>
      <p className="field-caption">Diligence checklist</p>
      <div className="checklist">{([["deckSent", "Deck sent"], ["ndaSigned", "NDA signed"], ["dataRoomShared", "Data room shared"], ["dueDiligence", "Due diligence"]] as [Editable, string][]).map(([key, label]) => <label key={key} className={draft[key] === "Yes" ? "on" : ""}><input type="checkbox" checked={draft[key] === "Yes"} onChange={() => toggle(key)} /> {label}</label>)}</div>
      <label className="field">Notes<textarea rows={4} value={draft.notes} onChange={set("notes")} /></label>
      <label className="field">Portfolio overlap / warm-intro angle<textarea rows={3} value={draft.introAngle} onChange={set("introAngle")} /></label>
      {error && <p className="form-error" role="alert">{error}</p>}
      {notice && !error && <p className="form-ok" role="status">{notice}</p>}
      <div className="drawer-actions"><button className="primary-button" type="submit" disabled={saving || !changed.length}>{saving ? "Saving…" : changed.length ? `Save changes (${changed.length})` : "Saved"}</button><button className="secondary-button" type="button" onClick={() => setLogging((v) => !v)}>Log a meeting</button></div>
    </form>
    {logging && <LogMeeting investorId={investor.id} onDone={(result) => { setLogging(false); onSaved(result.investor); setActivity(result.activity); }} />}
    <p className="eyebrow history-caption">History</p>
    {activity === null ? <p className="dim">Loading…</p> : activity.length === 0 ? <p className="dim">No history yet.</p> : activity.map((item) => <div className="history-row" key={item.id}><span className={`kind kind-${item.kind}`}>{item.kind}</span><p>{item.summary}</p><small>{when(item.at)}{item.actor ? ` · ${item.actor}` : ""}</small></div>)}
  </aside>;
}

function LogMeeting({ investorId, onDone }: { investorId: string; onDone: (result: { investor: Investor; activity: InvestorActivity[] }) => void }) {
  const [kind, setKind] = useState("meeting"); const [date, setDate] = useState(today()); const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try { onDone(await investorApi.logActivity(investorId, { kind, summary, ...(date && date !== today() ? { date } : {}) })); }
    catch (cause) { setError(message(cause, "Could not log this.")); } finally { setBusy(false); }
  }
  return <form className="log-form" onSubmit={submit}>
    <div className="field-row"><label className="field">Type<select value={kind} onChange={(e) => setKind(e.target.value)}><option value="meeting">Meeting</option><option value="call">Call</option><option value="email">Email</option><option value="note">Note</option></select></label><label className="field">Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} max={today()} /></label></div>
    <label className="field">What happened<textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} required /></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="primary-button" type="submit" disabled={busy || !summary.trim()}>{busy ? "Saving…" : "Add to history"}</button>
  </form>;
}

function AddInvestorDialog({ options, onClose, onCreated }: { options: InvestorOptions; onClose: () => void; onCreated: (investor: Investor) => void }) {
  const [form, setForm] = useState({ name: "", type: "VC", stageFocus: "", geography: "", website: "", priority: "Medium", status: "Prospect Identified", nextAction: "" });
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const input = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, v.trim() || null]));
    try { onCreated(await investorApi.create(input as InvestorInput)); } catch (cause) { setError(message(cause, "The investor could not be added.")); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop" role="presentation"><section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="add-investor-title">
    <header><div><p className="eyebrow">Investor pipeline</p><h2 id="add-investor-title">Add investor</h2></div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={18} /></button></header>
    <form onSubmit={submit}>
      <div className="form-grid">
        <label>Investor / fund<input value={form.name} onChange={set("name")} required autoFocus /></label>
        <label>Type<input value={form.type} onChange={set("type")} list="investor-types" /></label>
        <label>Stage focus<input value={form.stageFocus} onChange={set("stageFocus")} placeholder="Seed, Series A…" /></label>
        <label>Geography<input value={form.geography} onChange={set("geography")} /></label>
        <label>Website<input value={form.website} onChange={set("website")} placeholder="https://" /></label>
        <label>Priority<select value={form.priority} onChange={set("priority")}>{options.priorities.map((p) => <option key={p}>{p}</option>)}</select></label>
        <label>Stage<select value={form.status} onChange={set("status")}>{options.statuses.map((s) => <option key={s} value={s}>{sentence(s)}</option>)}</select></label>
        <label>Next action<input value={form.nextAction} onChange={set("nextAction")} /></label>
      </div>
      <datalist id="investor-types">{["VC", "Angel", "Family Office", "Corporate VC", "Private Equity", "Accelerator/Incubator", "Strategic Investor", "Sovereign Wealth Fund"].map((t) => <option key={t} value={t} />)}</datalist>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={busy || !form.name.trim()}>{busy ? "Adding…" : "Add investor"}</button></div>
    </form>
  </section></div>;
}
