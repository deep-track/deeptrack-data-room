import { Activity, BadgeCheck, Briefcase, Download, FileText, FolderClosed, Info, LayoutDashboard, LockKeyhole, LogOut, Plus, Search, Settings2, ShieldCheck, UserRoundCog, UsersRound, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { isAdministrator, roleDetails, type ReviewSession } from "./auth";
import { isAuth0Configured, sessionFromAuth0, type Auth0Bridge } from "./auth0-config";
import { configureAccessTokenProvider } from "./lib/repository";
import { LoginScreen } from "./components/LoginScreen";
import { UploadDialog } from "./components/UploadDialog";
import { InvestorPipeline } from "./components/InvestorPipeline";
import { dataRoomRepository, formatBytes } from "./lib/repository";
import type { AccessStatus, DataRoomDocument } from "./types";
import { placeOf, SECTIONS, TIERS } from "./lib/taxonomy";

// Sidebar selection: "All documents", a whole section ("section:Financials") or one folder ("Financials / Banking").
const ALL = "All documents";
const sectionSel = (name: string) => `section:${name}`;
function inSelection(document: DataRoomDocument, selection: string) {
  if (selection === ALL) return true;
  const place = placeOf(document.category);
  return selection.startsWith("section:") ? place.section === selection.slice(8) : place.key === selection;
}
function selectionTitle(selection: string) {
  if (selection === ALL) return { eyebrow: "The whole room", title: ALL };
  if (selection.startsWith("section:")) return { eyebrow: "Section", title: selection.slice(8) };
  const place = placeOf(selection);
  return { eyebrow: place.section, title: place.folder };
}
const tierLabel = { 1: "General", 2: "Diligence", 3: "Restricted" } as const;
type View = "documents" | "investors" | "access" | "governance";
type ActivityEvent = { at: string; event: string; actor: string; detail: string };

function formatDate(value: string) { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)); }
function readableTime(value: string) { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }

export default function App({ auth0 = null }: { auth0?: Auth0Bridge | null }) {
  const [session, setSession] = useState<ReviewSession | null>(null);
  useEffect(() => {
    if (!auth0) return;
    configureAccessTokenProvider(() => auth0.getAccessTokenSilently({ authorizationParams: { audience: import.meta.env.VITE_AUTH0_AUDIENCE } }));
    if (auth0.isAuthenticated && auth0.user) setSession(sessionFromAuth0(auth0.user));
    else if (!auth0.isLoading) setSession(null);
  }, [auth0?.isAuthenticated, auth0?.isLoading, auth0?.user]);
  const [documents, setDocuments] = useState<DataRoomDocument[]>([]);
  const [activeCategory, setActiveCategory] = useState(ALL);
  const [query, setQuery] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [selected, setSelected] = useState<DataRoomDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessStatus, setAccessStatus] = useState<AccessStatus | null>(null);
  const [ndaSubmitting, setNdaSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [view, setView] = useState<View>("documents");
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    dataRoomRepository.getAccessStatus()
      .then((status) => {
        if (!active) return [];
        setAccessStatus(status);
        if (status.role === "investor" && status.grant && !status.grant.ndaAcknowledgedAt) return [];
        return dataRoomRepository.listDocuments();
      })
      .then((records) => { if (active) setDocuments(records); })
      .catch((cause) => {
        if (!active) return;
        const message = cause instanceof Error ? cause.message : "Unable to load data-room documents.";
        if (auth0 && /grant|clearance|NDA|authorization/i.test(message)) {
          setSession(null);
          setAccessDenied(true);
        } else {
          setError(message);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function acknowledgeNda() {
    const version = accessStatus?.grant?.ndaVersion;
    if (!version) return;
    setNdaSubmitting(true); setError("");
    try {
      await dataRoomRepository.acknowledgeNda(version);
      setAccessStatus((current) => current?.grant ? { ...current, grant: { ...current.grant, ndaAcknowledgedAt: new Date().toISOString() } } : current);
      setLoading(true);
      setDocuments(await dataRoomRepository.listDocuments());
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to acknowledge the NDA."); }
    finally { setNdaSubmitting(false); setLoading(false); }
  }
  const administrator = session ? isAdministrator(session.role) : false;
  const permittedDocuments = useMemo(() => documents.filter((document) => !session || document.tier <= session.clearanceTier), [documents, session]);
  const visibleDocuments = useMemo(() => permittedDocuments.filter((document) => {
    const matchesCategory = inSelection(document, activeCategory);
    const haystack = `${document.title} ${document.description ?? ""} ${document.fileName ?? ""}`.toLowerCase();
    return matchesCategory && haystack.includes(query.trim().toLowerCase());
  }), [activeCategory, permittedDocuments, query]);

  function log(event: string, detail: string) { if (session) setActivity((current) => [{ at: new Date().toISOString(), event, detail, actor: session.displayName }, ...current].slice(0, 24)); }
  function enter(next: ReviewSession) { setSession(next); setView("documents"); log("Session opened", `${roleDetails[next.role].label} review mode`); }
  function leave() {
    setSession(null); setSelected(null); setShowUpload(false); setActivity([]);
    if (auth0) auth0.logout({ logoutParams: { returnTo: window.location.origin } });
  }

  async function download(document: DataRoomDocument) {
    if (!session || document.tier > session.clearanceTier) return setError("This document is not available for the current role and clearance tier.");
    if (document.source === "link" && document.link) { window.open(document.link, "_blank", "noopener,noreferrer"); log("Secure link opened", document.title); return; }
    setDownloadingId(document.id); setError("");
    try {
      const url = await dataRoomRepository.getDownloadUrl(document.id);
      if (!url) throw new Error("This file is not available in this browser. In production, an authorized download service will retrieve it from private storage.");
      const anchor = window.document.createElement("a"); anchor.href = url; anchor.download = document.fileName ?? document.title; window.document.body.appendChild(anchor); anchor.click(); anchor.remove();
      if (!url.startsWith("https://")) window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      log("Document download prepared", `${document.title} · ${document.versions.at(-1)?.version ?? "1.0"}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The document could not be downloaded."); } finally { setDownloadingId(null); }
  }

  if (auth0?.isLoading) return <main className="login-page"><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Secure entry</p><h2>Checking your session…</h2><p className="login-note">Verifying your Auth0 identity before loading the data room.</p></div></section></main>;
  if (accessDenied) return <main className="login-page"><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Access restricted</p><h2>Invitation required</h2><p className="login-note">Your Auth0 identity was verified, but it is not on the approved investor allowlist. Contact Deeptrack Investor Relations for an active data-room grant.</p><button className="primary-button login-submit" type="button" onClick={() => auth0?.logout({ logoutParams: { returnTo: window.location.origin } })}>Sign out</button></div></section></main>;
  if (!session) return <LoginScreen onContinue={enter} auth0={auth0} />;
  const role = roleDetails[session.role];
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true">///</span><div><strong>deeptrack</strong><span>Data room</span></div></div><div className="role-card"><p>{role.label}</p><span>{session.displayName}</span><small>{administrator ? "Administrative review" : "Read-only review"}</small></div><nav aria-label="Data room navigation"><p className="nav-caption">Workspace</p><button className={`nav-item ${view === "documents" ? "active" : ""}`} onClick={() => setView("documents")}><LayoutDashboard size={17} /> Documents</button>{administrator && <><button className={`nav-item ${view === "investors" ? "active" : ""}`} onClick={() => setView("investors")}><Briefcase size={17} /><span>Investor pipeline</span><em className="nav-badge">Private</em></button><button className={`nav-item ${view === "access" ? "active" : ""}`} onClick={() => setView("access")}><UsersRound size={17} /> Access &amp; Settings</button><button className={`nav-item ${view === "governance" ? "active" : ""}`} onClick={() => setView("governance")}><Settings2 size={17} /> Room Activity</button></>} {view === "documents" && <><p className="nav-caption">Sections</p><button className={`nav-item ${activeCategory === ALL ? "active" : ""}`} onClick={() => setActiveCategory(ALL)}><FolderClosed size={17} /><span>{ALL}</span><small>{permittedDocuments.length}</small></button>{SECTIONS.map((section) => { const open = activeCategory === sectionSel(section.name) || placeOf(activeCategory).section === section.name; return <div key={section.name}><button className={`nav-item ${activeCategory === sectionSel(section.name) ? "active" : ""}`} onClick={() => setActiveCategory(sectionSel(section.name))} aria-expanded={open}><FolderClosed size={17} /><span>{section.name}</span><small>{permittedDocuments.filter((document) => inSelection(document, sectionSel(section.name))).length}</small></button>{open && section.folders.map((folder) => { const key = `${section.name} / ${folder.name}`; return <button key={key} className={`nav-item nav-folder ${activeCategory === key ? "active" : ""}`} onClick={() => setActiveCategory(key)} title={folder.holds}><span>{folder.name}</span><small>{permittedDocuments.filter((document) => inSelection(document, key)).length}</small></button>; })}</div>; })}</>}</nav><div className="sidebar-foot"><ShieldCheck size={17} /><span>Production access requires server-side identity and authorization.</span></div></aside><main><header className="topbar"><div><p className="eyebrow">Investor relations · {role.label}</p><h1>Deeptrack data room</h1></div><div className="topbar-actions"><div className="status"><span></span> Review mode</div>{administrator && view !== "investors" && <button className="primary-button" onClick={() => setShowUpload(true)}><Plus size={17} /> File a document</button>}<button className="session-button" onClick={leave}><LogOut size={16} /> End session</button></div></header>{view === "investors" && administrator ? <section className="notice"><LockKeyhole size={18} /><div><strong>Private to Founder and Chief of Staff.</strong><p>Investors with data-room access can&apos;t see this list. Every change is written to the audit log.</p></div></section> : <section className="notice"><Info size={18} /><div><strong>{administrator ? "Administrative review mode is active." : "Investor read-only review mode is active."}</strong><p>{administrator ? "Founder and Chief of Staff controls are represented for workflow review. Production permissions must be enforced by the data-room API." : "You may view permitted records and download allowed documents. Upload, editing, access changes, and administration are unavailable to investors."}</p></div></section>}<section className="workspace">{error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss error"><X size={16} /></button></div>}{session.role === "investor" && accessStatus?.grant && !accessStatus.grant.ndaAcknowledgedAt && <section className="notice"><LockKeyhole size={18} /><div><strong>NDA acknowledgement required</strong><p>Review the current non-disclosure agreement before accessing permitted data-room documents. Grant expires {formatDate(accessStatus.grant.expiresAt)}.</p><button className="primary-button" onClick={acknowledgeNda} disabled={ndaSubmitting}>{ndaSubmitting ? "Recording acknowledgement…" : `Acknowledge NDA ${accessStatus.grant.ndaVersion}`}</button></div></section>}{view === "documents" && <DocumentsView session={session} administrator={administrator} activeCategory={activeCategory} setActiveCategory={setActiveCategory} query={query} setQuery={setQuery} documents={documents} visibleDocuments={visibleDocuments} loading={loading} downloadingId={downloadingId} onUpload={() => setShowUpload(true)} onSelect={setSelected} onDownload={download} />}{view === "investors" && administrator && <InvestorPipeline />}{view === "access" && administrator && <AccessView role={session.role} onLog={log} />}{view === "governance" && administrator && <GovernanceView activity={activity} />}</section></main>{showUpload && administrator && <UploadDialog repository={dataRoomRepository} initialFolder={activeCategory.includes(" / ") ? activeCategory : activeCategory.startsWith("section:") ? `${activeCategory.slice(8)} / ${SECTIONS.find((s) => s.name === activeCategory.slice(8))?.folders[0]?.name ?? ""}` : undefined} onClose={() => setShowUpload(false)} onCreated={(document) => { setDocuments((current) => [document, ...current]); setShowUpload(false); setSelected(document); log("Document filed", `${document.title} · ${document.category}`); }} />}{selected && <DocumentDrawer document={selected} session={session} administrator={administrator} onClose={() => setSelected(null)} onDownload={download} downloading={downloadingId === selected.id} onVersionAdded={(document) => { setDocuments((current) => current.map((item) => item.id === document.id ? document : item)); setSelected(document); log("New version added", `${document.title} · ${document.versions.at(-1)?.version ?? ""}`); }} />}</div>;
}

type DocumentsViewProps = { session: ReviewSession; administrator: boolean; activeCategory: string; setActiveCategory: (value: string) => void; query: string; setQuery: (value: string) => void; documents: DataRoomDocument[]; visibleDocuments: DataRoomDocument[]; loading: boolean; downloadingId: string | null; onUpload: () => void; onSelect: (document: DataRoomDocument) => void; onDownload: (document: DataRoomDocument) => void };
function DocumentsView({ session, administrator, activeCategory, query, setQuery, documents, visibleDocuments, loading, downloadingId, onUpload, onSelect, onDownload }: DocumentsViewProps) {
  return <><div className="workspace-head"><div><p className="eyebrow">{selectionTitle(activeCategory).eyebrow}</p><h2>{selectionTitle(activeCategory).title}</h2><p className="subcopy">{activeCategory.includes(" / ") ? placeOf(activeCategory).section === "Other" ? "Filed before the current room map." : `What goes here: ${SECTIONS.flatMap((s) => s.folders).find((f) => f.name === placeOf(activeCategory).folder)?.holds ?? ""}` : administrator ? "Every document sits in a section and folder, at one of three clearance tiers." : "Documents available at your clearance tier."}</p></div><label className="search"><Search size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search permitted documents" aria-label="Search permitted documents" /></label></div><section className="metrics" aria-label="Data room overview"><article><span>Permitted documents</span><strong>{visibleDocuments.length}</strong><p>{administrator ? "Within this workspace" : `Tier ${session.clearanceTier} access`}</p></article><article><span>Access role</span><strong>{roleDetails[session.role].label}</strong><p>{administrator ? "Administrative controls" : "Read-only controls"}</p></article><article><span>Disclosure policy</span><strong>Approved</strong><p>Production review required</p></article></section><section className="document-panel"><div className="table-head"><div><h3>Document ledger</h3><p>{loading ? "Loading records…" : `${visibleDocuments.length} permitted document${visibleDocuments.length === 1 ? "" : "s"}`}</p></div>{administrator && <button className="secondary-button" onClick={onUpload}><Plus size={16} /> File a document</button>}</div>{loading ? <div className="empty-state">Loading documents…</div> : visibleDocuments.length === 0 ? <div className="empty-state"><FileText size={28} /><h3>{documents.length ? "Nothing filed here yet" : "The room is ready for its first document"}</h3><p>{administrator ? "Use File a document to add one here: set the tier, then choose Link or Upload." : "No documents are available at your clearance tier yet."}</p>{administrator && <button className="primary-button" onClick={onUpload}><Plus size={16} /> File a document</button>}</div> : <div className="ledger"><div className="ledger-heading"><span>Document</span><span>Tier</span><span>Version</span><span>Updated</span><span>Action</span></div>{visibleDocuments.map((document) => <article className="ledger-row" key={document.id}><button className="document-name" onClick={() => onSelect(document)}><FileText size={19} /><span><strong>{document.title}</strong><small>{activeCategory.includes(" / ") ? (document.description ?? document.fileName ?? "") : `${placeOf(document.category).section} › ${placeOf(document.category).folder}`}</small></span></button><span className={`tier tier-${document.tier}`}>{tierLabel[document.tier]}</span><span className="mono">{document.versions.at(-1)?.version ?? "1.0"}</span><span className="mono dim">{formatDate(document.updatedAt)}</span><button className="download-button" onClick={() => onDownload(document)} disabled={downloadingId === document.id} aria-label={`Download ${document.title}`}>{downloadingId === document.id ? "…" : <Download size={16} />}</button></article>)}</div>}</section></>;
}

function AccessView({ role, onLog }: { role: ReviewSession["role"]; onLog: (event: string, detail: string) => void }) {
  const canManageAdmins = role === "founder";
  return <section className="admin-view"><p className="eyebrow">Access control</p><h2>Invitations, clearance, and access windows</h2><p className="subcopy">Production invitations must be server-issued, expire automatically, and only activate after NDA acceptance. This interface records the operating model without creating real credentials.</p><div className="governance-grid"><article><UserRoundCog size={21} /><h3>Founder ownership</h3><p>Super privileges for room policy, administrator assignment, final publication, restriction, and audit oversight.</p><span className="control-state">{canManageAdmins ? "Manage administrators" : "Founder-managed"}</span></article><article><UsersRound size={21} /><h3>Chief of Staff</h3><p>Same full access and room management rights as the Founder.</p><span className="control-state">Administrative access</span></article><article><LockKeyhole size={21} /><h3>Investor invitations</h3><p>Require a firm, clearance tier, expiry, NDA state, and server-side authentication before access.</p><button className="secondary-button" onClick={() => onLog("Invitation workflow reviewed", "Production invite creation requires the server-side API")}>Review invitation policy</button></article>{canManageAdmins && <article><BadgeCheck size={21} /><h3>Founder-only authority</h3><p>Appoint or revoke the Chief of Staff, set room-wide policy, and approve the final withdrawal or publication boundary.</p><button className="secondary-button" onClick={() => onLog("Founder ownership controls reviewed", "Administrator assignment and room policy require a production founder authorization check")}>Review ownership controls</button></article>}</div><section className="document-panel access-table"><div className="table-head"><div><h3>Required production access record</h3><p>Do not create real investor credentials in browser-local review mode.</p></div></div><div className="access-row"><strong>Investor identity</strong><span>Verified name, firm, work email, and identity-provider subject</span></div><div className="access-row"><strong>Authorization</strong><span>Clearance tier, document policy, NDA version, expiry, and revocation state</span></div><div className="access-row"><strong>Audit evidence</strong><span>Login, denial, acknowledgement, document view, download, and access changes</span></div></section></section>;
}

function GovernanceView({ activity }: { activity: ActivityEvent[] }) {
  const events = activity.length ? activity : [{ at: new Date().toISOString(), event: "Governance view opened", actor: "Review session", detail: "Production events must be written by the server" }];
  return <section className="admin-view"><p className="eyebrow">Governance</p><h2>Comprehensive document operations</h2><p className="subcopy">Investor-visible documents require controlled review, immutable version discipline, expiring access, and server-generated audit evidence.</p><div className="governance-grid"><article><BadgeCheck size={21} /><h3>Disclosure review</h3><p>Only approved documents should become visible to investors. Retain owner, reviewer, approval time, and next review date.</p><span className="control-state">Server policy required</span></article><article><ShieldCheck size={21} /><h3>Private distribution</h3><p>Issue short-lived private URLs after role, tier, expiry, NDA, and document-status checks.</p><span className="control-state">Private S3 design documented</span></article><article><Activity size={21} /><h3>Download evidence</h3><p>Audit viewer identity, document version, timestamp, source IP, and generated URL disposition.</p><span className="control-state">Server audit required</span></article></div><section className="document-panel audit-panel"><div className="table-head"><div><h3>Review-mode activity</h3><p>Illustrative client view; production audit events must be append-only server records.</p></div></div>{events.map((event, index) => <div className="audit-row" key={`${event.at}-${index}`}><span className="audit-dot"></span><div><strong>{event.event}</strong><p>{event.detail}</p></div><div><span>{event.actor}</span><small>{readableTime(event.at)}</small></div></div>)}</section></section>;
}

function DocumentDrawer({ document, session, onClose, onDownload, downloading , administrator, onVersionAdded }: { document: DataRoomDocument; session: ReviewSession; onClose: () => void; onDownload: (document: DataRoomDocument) => void; downloading: boolean ; administrator: boolean; onVersionAdded: (document: DataRoomDocument) => void }) {
  return <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title"><button className="drawer-close" onClick={onClose}><X size={18} /> Close</button><p className="eyebrow">{placeOf(document.category).section} › {placeOf(document.category).folder}</p><h2 id="drawer-title">{document.title}</h2><p className="drawer-description">{document.description || "No additional reading context was filed for this document."}</p><dl><div><dt>Section</dt><dd>{placeOf(document.category).section}</dd></div><div><dt>Folder</dt><dd>{placeOf(document.category).folder}</dd></div><div><dt>Clearance tier</dt><dd>{document.tier} — {tierLabel[document.tier]}</dd></div><div><dt>Viewer role</dt><dd>{roleDetails[session.role].label}</dd></div><div><dt>Source</dt><dd>{document.source === "upload" ? "Upload" : "Link"}</dd></div><div><dt>File size</dt><dd>{formatBytes(document.sizeBytes)}</dd></div><div><dt>Last updated</dt><dd>{formatDate(document.updatedAt)}</dd></div></dl><h3>Version history</h3>{administrator && <AddVersion document={document} onAdded={onVersionAdded} />}{[...document.versions].reverse().map((version) => <div className="version" key={version.createdAt}><span>{version.version}</span><p>{version.note}</p><small>{formatDate(version.createdAt)}</small></div>)}<div className="drawer-policy"><LockKeyhole size={15} /><span>Production downloads require an active NDA, access window, clearance check, and audit event.</span></div><button className="primary-button drawer-download" onClick={() => onDownload(document)} disabled={downloading}>{downloading ? "Preparing download…" : <><Download size={16} /> {document.source === "upload" ? "Download document" : "Open secure link"}</>}</button></aside>;
}

// Replacing a file: record a new version with a short note on what changed (User Guide, section 4).
function AddVersion({ document, onAdded }: { document: DataRoomDocument; onAdded: (document: DataRoomDocument) => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  if (!open) return <button className="secondary-button add-version" onClick={() => setOpen(true)}><Plus size={15} /> Add a version</button>;
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!note.trim()) return setError("Say what changed in this version.");
    if (label.trim() && !/^\d{1,3}(\.\d{1,3}){0,2}$/.test(label.trim())) return setError("Version label should look like 1.1 or 2.0.");
    setSaving(true); setError("");
    try { onAdded(await dataRoomRepository.addVersion(document.id, note.trim(), label.trim() || undefined)); setOpen(false); setNote(""); setLabel(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The version could not be saved."); }
    finally { setSaving(false); }
  }
  return <form className="add-version-form" onSubmit={save}><label><span>What changed</span><input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Updated with Q3 actuals" autoFocus /></label><label><span>Version label</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Next (e.g. 1.1)" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="text-button" onClick={() => setOpen(false)}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? "Saving…" : "Save version"}</button></div></form>;
}
