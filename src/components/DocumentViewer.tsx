import { Download, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { readWorkbook, type Cell } from "../lib/xlsx";
import type { DataRoomDocument } from "../types";

// View a document inside the data room instead of downloading it.
// PDFs and images are shown by the browser from a short-lived private link; Word and Excel
// files are rendered here in the browser, so the file never goes to an outside viewer.
type Kind = "pdf" | "image" | "docx" | "xlsx" | "text" | "other";

function kindOf(document: DataRoomDocument): Kind {
  const name = (document.fileName ?? "").toLowerCase();
  const type = (document.mimeType ?? "").toLowerCase();
  if (type === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (type.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/.test(name)) return "image";
  if (name.endsWith(".docx") || type.includes("wordprocessingml")) return "docx";
  if (name.endsWith(".xlsx") || type.includes("spreadsheetml")) return "xlsx";
  if (type.startsWith("text/") || /\.(txt|csv|md)$/.test(name)) return "text";
  return "other";
}

export function canView(document: DataRoomDocument) {
  return document.source === "link" || kindOf(document) !== "other";
}

type Props = { document: DataRoomDocument; getUrl: () => Promise<string | null>; onClose: () => void; onDownload: () => void };

export function DocumentViewer({ document, getUrl, onClose, onDownload }: Props) {
  const kind = kindOf(document);
  const [url, setUrl] = useState<string | null>(null);
  const [sheets, setSheets] = useState<Array<{ name: string; rows: Cell[][] }> | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [docxReady, setDocxReady] = useState(false);
  const docxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const link = await getUrl();
        if (!link) throw new Error("This file isn't available to view.");
        if (cancelled) return;
        if (kind === "pdf" || kind === "image") { setUrl(link); return; }
        const response = await fetch(link);
        if (!response.ok) throw new Error("The file could not be loaded for viewing.");
        const blob = await response.blob();
        if (cancelled) return;
        if (kind === "docx" && docxRef.current) {
          const { renderAsync } = await import("docx-preview");
          await renderAsync(blob, docxRef.current, undefined, { inWrapper: true, ignoreLastRenderedPageBreak: true, experimental: false });
          if (!cancelled) setDocxReady(true);
        } else if (kind === "xlsx") {
          const book = await readWorkbook(new File([blob], document.fileName ?? "sheet.xlsx"));
          setSheets([...book.entries()].map(([name, rows]) => ({ name, rows: rows.slice(0, 500) })));
        } else if (kind === "text") {
          setText((await blob.text()).slice(0, 200_000));
        }
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "The document could not be shown.");
      }
    })();
    return () => { cancelled = true; };
  }, [document.id]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loading = !error && (kind === "docx" ? !docxReady : !url && !sheets && text === null);
  return <div className="viewer-backdrop" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="viewer" role="dialog" aria-modal="true" aria-labelledby="viewer-title">
      <header className="viewer-head">
        <div><p className="eyebrow">Viewing · {document.versions.at(-1)?.version ?? "1.0"}</p><h2 id="viewer-title">{document.title}</h2></div>
        <div className="viewer-actions"><button className="secondary-button" onClick={onDownload}><Download size={15} /> Download</button><button className="icon-button" onClick={onClose} aria-label="Close viewer"><X size={19} /></button></div>
      </header>
      <div className="viewer-body">
        {error ? <div className="empty-state"><h3>Can't show this document</h3><p>{error}</p></div>
          : loading ? <div className="empty-state">Opening document…</div>
          : kind === "pdf" && url ? <iframe className="viewer-frame" src={url} title={document.title} />
          : kind === "image" && url ? <img className="viewer-image" src={url} alt={document.title} />
          : kind === "text" && text !== null ? <pre className="viewer-text">{text}</pre>
          : kind === "xlsx" && sheets ? <div className="viewer-sheets">{sheets.map((sheet) => <div key={sheet.name}><h3>{sheet.name}</h3><div className="viewer-table-wrap"><table className="viewer-table"><tbody>{sheet.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c}>{cell === null ? "" : String(cell)}</td>)}</tr>)}</tbody></table></div></div>)}</div>
          : null}
        {kind === "docx" && !error && <div ref={docxRef} className="viewer-docx" />}
      </div>
    </section>
  </div>;
}
