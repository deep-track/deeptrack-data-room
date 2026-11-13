import { FileUp, Link2, UploadCloud, X } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { formatBytes } from "../lib/repository";
import { folderKey, MAX_UPLOAD_MB, placeOf, SECTIONS, TIERS } from "../lib/taxonomy";
import type { ClearanceTier, DataRoomDocument, DataRoomRepository, DocumentSource } from "../types";

const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const blockedExtensions = /\.(?:bat|cmd|com|dll|exe|html?|jar|js|mjs|msi|ps1|sh|vbs|svg)$/i;

// "File a document" (User Guide, section 4): title, section & folder, clearance tier,
// version label, and a Link or an Upload.
type Props = { repository: DataRoomRepository; initialFolder?: string; onClose: () => void; onCreated: (document: DataRoomDocument) => void };

export function UploadDialog({ repository, initialFolder, onClose, onCreated }: Props) {
  const start = initialFolder ? placeOf(initialFolder) : null;
  const startSection = SECTIONS.find((s) => s.name === start?.section) ?? SECTIONS[0];
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<DocumentSource>("link");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [section, setSection] = useState(startSection.name);
  const [folder, setFolder] = useState(startSection.folders.find((f) => f.name === start?.folder)?.name ?? startSection.folders[0].name);
  const [tier, setTier] = useState<ClearanceTier>(1);
  const [version, setVersion] = useState("1.0");
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const folders = useMemo(() => SECTIONS.find((s) => s.name === section)?.folders ?? [], [section]);
  const holds = folders.find((f) => f.name === folder)?.holds;

  function chooseSection(name: string) {
    setSection(name);
    setFolder(SECTIONS.find((s) => s.name === name)?.folders[0]?.name ?? "");
  }

  function chooseFile(next: File | null) {
    setError("");
    if (!next) return setFile(null);
    if (next.size > MAX_UPLOAD_BYTES) return setError(`Uploads are capped at ${MAX_UPLOAD_MB} MB per file. Use a link for anything larger.`);
    if (blockedExtensions.test(next.name)) return setError("For safety, executable and web-script file types cannot be filed in the data room.");
    setFile(next);
    if (!title) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const cleanTitle = title.trim();
    if (!cleanTitle) return setError("Give the document a plain, specific title before filing it.");
    if (!/^\d{1,3}(\.\d{1,3}){0,2}$/.test(version.trim())) return setError("Version label should look like 1.0, 1.1 or 2.0.");
    if (source === "upload" && !file) return setError("Choose a file to upload, or switch to Link.");
    if (source === "link") {
      try { const parsed = new URL(link); if (parsed.protocol !== "https:") throw new Error(); } catch { return setError("Use a valid HTTPS link (Drive, Notion, etc.)."); }
    }
    setStatus("saving");
    try {
      const base = { title: cleanTitle, category: folderKey(section, folder), tier, version: version.trim(), source, link: source === "link" ? link.trim() : undefined, description: description.trim() || undefined };
      const document = source === "upload" && file ? await repository.createUploadedDocument(base, file) : await repository.createLinkedDocument(base);
      onCreated(document);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "The document could not be filed. Please try again.");
    }
  }

  return <div className="modal-backdrop" role="presentation"><section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title">
    <header><div><p className="eyebrow">Data room</p><h2 id="upload-title">File a document</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>
    <form onSubmit={submit}>
      <div className="form-grid">
        <label className="full-field"><span>Title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="SAFE Note — $750K pre-seed" autoFocus /></label>
        <label><span>Section</span><select value={section} onChange={(event) => chooseSection(event.target.value)}>{SECTIONS.map((s) => <option value={s.name} key={s.name}>{s.name}</option>)}</select></label>
        <label><span>Folder</span><select value={folder} onChange={(event) => setFolder(event.target.value)}>{folders.map((f) => <option value={f.name} key={f.name}>{f.name}</option>)}</select></label>
        {holds && <p className="field-hint full-field"><strong>What goes here:</strong> {holds}</p>}
        <label><span>Clearance tier</span><select value={tier} onChange={(event) => setTier(Number(event.target.value) as ClearanceTier)}>{TIERS.map((t) => <option value={t.tier} key={t.tier}>{t.tier} — {t.name} · {t.who}</option>)}</select></label>
        <label><span>Version label</span><input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.0" inputMode="decimal" /></label>
        <p className="field-hint full-field">File at General unless there&apos;s a specific reason not to. Start versions at 1.0 and bump them (1.1, 2.0…) when you replace the file.</p>
        <label className="full-field"><span>Description (optional)</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="One line of context for investors" /></label>
      </div>
      <fieldset><legend>Source</legend>
        <div className="source-tabs"><button type="button" className={source === "link" ? "active" : ""} onClick={() => setSource("link")}><Link2 size={16} /> Link</button><button type="button" className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}><UploadCloud size={16} /> Upload</button></div>
        {source === "upload"
          ? <div className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files.item(0)); }}><input ref={inputRef} className="visually-hidden" type="file" onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} /><FileUp size={23} /><div>{file ? <><strong>{file.name}</strong><span>{formatBytes(file.size)} · ready to file</span></> : <><strong>Drop a file here</strong><span>The file lives in the room itself. Up to {MAX_UPLOAD_MB} MB; use a link for anything larger.</span></>}</div><button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>Choose file</button></div>
          : <label className="full-field"><span>Link to where the document already lives</span><input value={link} onChange={(event) => setLink(event.target.value)} type="url" placeholder="https://drive.google.com/…" /><small className="field-hint">That location stays the single source of truth; the room just points to it.</small></label>}
      </fieldset>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={status === "saving"}>{status === "saving" ? "Filing…" : "File document"}</button></div>
    </form>
  </section></div>;
}
