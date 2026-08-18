import { FileUp, Link2, UploadCloud, X } from "lucide-react";
import { useRef, useState } from "react";
import { formatBytes } from "../lib/repository";
import type { ClearanceTier, DataRoomDocument, DataRoomRepository, DocumentSource } from "../types";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const blockedExtensions = /\.(?:bat|cmd|com|dll|exe|html?|jar|js|mjs|msi|ps1|sh|vbs)$/i;
const categories = ["Fundraise materials", "Financials", "Technology", "Legal", "Governance"];

type Props = { repository: DataRoomRepository; onClose: () => void; onCreated: (document: DataRoomDocument) => void };

export function UploadDialog({ repository, onClose, onCreated }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<DocumentSource>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState(categories[0]);
  const [tier, setTier] = useState<ClearanceTier>(1);
  const [link, setLink] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");

  function chooseFile(next: File | null) {
    setError("");
    if (!next) return setFile(null);
    if (next.size > MAX_UPLOAD_BYTES) return setError("This local preview supports documents up to 25 MB. Configure the production storage policy for larger files.");
    if (blockedExtensions.test(next.name)) return setError("For safety, executable and web-script file types cannot be filed in the data room.");
    setFile(next);
    if (!title) setTitle(next.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    const cleanTitle = title.trim();
    if (!cleanTitle) return setError("Give the document a clear title before filing it.");
    if (source === "upload" && !file) return setError("Choose a document to upload, or switch to the link option.");
    if (source === "link") {
      try { const parsed = new URL(link); if (parsed.protocol !== "https:") throw new Error(); } catch { return setError("Use a valid HTTPS document link."); }
    }
    setStatus("saving");
    try {
      const base = { title: cleanTitle, category, tier, source, link: source === "link" ? link.trim() : undefined, description: description.trim() || undefined };
      const document = source === "upload" && file ? await repository.createUploadedDocument(base, file) : await repository.createLinkedDocument(base);
      onCreated(document);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : "The document could not be filed. Please try again.");
    }
  }

  return <div className="modal-backdrop" role="presentation"><section className="upload-dialog" role="dialog" aria-modal="true" aria-labelledby="upload-title"><header><div><p className="eyebrow">Document control</p><h2 id="upload-title">File a document</h2></div><button className="icon-button" type="button" onClick={onClose} aria-label="Close upload dialog"><X size={19} /></button></header><form onSubmit={submit}><div className="form-grid"><label><span>Document title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Q2 board materials" autoFocus /></label><label><span>Folder</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label><span>Clearance tier</span><select value={tier} onChange={(event) => setTier(Number(event.target.value) as ClearanceTier)}><option value={1}>General — cleared investors</option><option value={2}>Diligence — invited reviewers</option><option value={3}>Restricted — founder & staff</option></select></label><label><span>Context (optional)</span><input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="One line of reading context" /></label></div><fieldset><legend>Document source</legend><div className="source-tabs"><button type="button" className={source === "upload" ? "active" : ""} onClick={() => setSource("upload")}><UploadCloud size={16} /> Upload document</button><button type="button" className={source === "link" ? "active" : ""} onClick={() => setSource("link")}><Link2 size={16} /> Secure link</button></div>{source === "upload" ? <div className="drop-zone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); chooseFile(event.dataTransfer.files.item(0)); }}><input ref={inputRef} className="visually-hidden" type="file" onChange={(event) => chooseFile(event.target.files?.item(0) ?? null)} /><FileUp size={23} /><div>{file ? <><strong>{file.name}</strong><span>{formatBytes(file.size)} · ready to file</span></> : <><strong>Drop a document here</strong><span>PDF, spreadsheet, presentation, or other non-executable file up to 25 MB.</span></>}</div><button type="button" className="secondary-button" onClick={() => inputRef.current?.click()}>Choose file</button></div> : <label className="full-field"><span>HTTPS document link</span><input value={link} onChange={(event) => setLink(event.target.value)} type="url" placeholder="https://secure.example.com/document" /></label>}</fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" className="text-button" onClick={onClose}>Cancel</button><button type="submit" className="primary-button" disabled={status === "saving"}>{status === "saving" ? "Filing document…" : "File document"}</button></div></form></section></div>;
}
