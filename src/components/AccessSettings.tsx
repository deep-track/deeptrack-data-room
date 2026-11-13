import { MailPlus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { authorizedRequest } from "../lib/repository";

// Access & Settings (User Guide, section 7): invite an investor by email at a starting tier,
// then Grant diligence / Set general / Revoke. The investor signs in at investors.deeptrack.io
// with Google using the invited email; the grant attaches to their account on first sign-in.
type Grant = {
  id: string; investorEmail: string; firmName?: string; clearanceTier: 1 | 2 | 3; ndaVersion: string; ndaAcknowledgedAt?: string;
  expiresAt: string; revokedAt?: string; signedIn: boolean; status: "invited" | "nda_pending" | "active" | "expired" | "revoked"; createdAt: string;
};

const STATUS: Record<Grant["status"], string> = { invited: "Invited — not signed in yet", nda_pending: "NDA pending", active: "NDA signed", expired: "Expired", revoked: "Revoked" };
const TIER = { 1: "General", 2: "Diligence", 3: "Restricted" } as const;
const DEFAULT_NDA = "2026-11";

function inDays(days: number) { const d = new Date(Date.now() + days * 86400000); return d.toISOString().slice(0, 10); }
function shortDate(value: string) { return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(value)); }

export function AccessSettings({ onLog }: { onLog: (event: string, detail: string) => void }) {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [email, setEmail] = useState("");
  const [firm, setFirm] = useState("");
  const [tier, setTier] = useState<1 | 2>(1);
  const [expires, setExpires] = useState(inDays(90));
  const [nda, setNda] = useState(DEFAULT_NDA);
  const [sendEmail, setSendEmail] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  async function load() {
    try { setGrants(await authorizedRequest<Grant[]>("/access/grants")); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Investor access could not be loaded."); setGrants([]); }
  }
  useEffect(() => { void load(); }, []);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setError(""); setMessage("");
    const address = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(address)) return setError("Enter the investor's email address.");
    setBusy("invite");
    try {
      const result = await authorizedRequest<{ emailSent?: boolean; emailError?: string }>("/access/grants", { method: "POST", body: JSON.stringify({ investorEmail: address, firmName: firm.trim() || undefined, clearanceTier: tier, ndaVersion: nda.trim() || DEFAULT_NDA, expiresAt: new Date(`${expires}T23:59:59`).toISOString(), sendEmail }) });
      setMessage(result.emailSent ? `Invited ${address} and emailed them the invitation.` : `Invited ${address}.${result.emailError ? ` ${result.emailError}` : ""} Send them https://investors.deeptrack.io and ask them to sign in with Google using ${address}.`);
      onLog("Investor invited", `${address} · ${TIER[tier]}`);
      setEmail(""); setFirm(""); setTier(1);
      await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The invitation could not be created."); }
    finally { setBusy(null); }
  }

  async function changeTier(grant: Grant, next: 1 | 2) {
    setBusy(grant.id); setError(""); setMessage("");
    try { await authorizedRequest(`/access/grants/${encodeURIComponent(grant.id)}/tier`, { method: "POST", body: JSON.stringify({ clearanceTier: next }) }); onLog(next === 2 ? "Diligence granted" : "Set to general", grant.investorEmail); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The tier could not be changed."); }
    finally { setBusy(null); }
  }

  async function resend(grant: Grant) {
    setBusy(grant.id); setError(""); setMessage("");
    try {
      const result = await authorizedRequest<{ emailSent: boolean; emailError?: string }>(`/access/grants/${encodeURIComponent(grant.id)}/email`, { method: "POST" });
      if (result.emailSent) { setMessage(`Invitation emailed again to ${grant.investorEmail}.`); onLog("Invitation resent", grant.investorEmail); }
      else setError(result.emailError ?? "The email could not be sent.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The email could not be sent."); }
    finally { setBusy(null); }
  }

  async function revoke(grant: Grant) {
    setBusy(grant.id); setError(""); setMessage(""); setConfirmRevoke(null);
    try { await authorizedRequest(`/access/grants/${encodeURIComponent(grant.id)}/revoke`, { method: "POST" }); onLog("Access revoked", grant.investorEmail); await load(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Access could not be revoked."); }
    finally { setBusy(null); }
  }

  const live = (grant: Grant) => grant.status !== "revoked" && grant.status !== "expired";
  return <section className="admin-view">
    <p className="eyebrow">Access &amp; Settings</p>
    <h2>Investor access</h2>
    <p className="subcopy">Invite an investor by email at a starting tier. They sign in at investors.deeptrack.io with Google using that email, accept the confidentiality acknowledgement, and then see documents at their tier. Every change is recorded in Room Activity.</p>

    <form className="document-panel invite-form" onSubmit={invite}>
      <div className="table-head"><div><h3>Invite an investor</h3><p>One invitation per person; firms with several people get one each.</p></div></div>
      <div className="invite-grid">
        <label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@fund.com" required /></label>
        <label><span>Firm</span><input value={firm} onChange={(event) => setFirm(event.target.value)} placeholder="Fund or firm name" /></label>
        <label><span>Starting tier</span><select value={tier} onChange={(event) => setTier(Number(event.target.value) as 1 | 2)}><option value={1}>General — first look</option><option value={2}>Diligence — active diligence</option></select></label>
        <label><span>Access until</span><input type="date" value={expires} min={inDays(1)} onChange={(event) => setExpires(event.target.value)} /></label>
        <label><span>NDA version</span><input value={nda} onChange={(event) => setNda(event.target.value)} /></label>
        <label className="invite-check"><input type="checkbox" checked={sendEmail} onChange={(event) => setSendEmail(event.target.checked)} /> Email the invitation</label>
        <div className="invite-submit"><button className="primary-button" disabled={busy === "invite"}><MailPlus size={16} /> {busy === "invite" ? "Inviting…" : "Invite"}</button></div>
      </div>
      {message && <p className="form-success" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </form>

    <section className="document-panel access-table">
      <div className="table-head"><div><h3>Investors</h3><p>{grants === null ? "Loading…" : `${grants.filter(live).length} with access · ${grants.length} in total`}</p></div><button className="secondary-button" onClick={() => void load()}><RefreshCw size={15} /> Refresh</button></div>
      {grants !== null && grants.length === 0 && <div className="empty-state"><h3>No investors invited yet</h3><p>Use the form above to invite the first one.</p></div>}
      {grants?.map((grant) => <div className="grant-row" key={grant.id}>
        <div className="grant-who"><strong>{grant.firmName || grant.investorEmail}</strong><small>{grant.firmName ? grant.investorEmail : ""}</small></div>
        <span className={`tier tier-${grant.clearanceTier}`}>{TIER[grant.clearanceTier]}</span>
        <span className={`grant-status status-${grant.status}`}>{STATUS[grant.status]}</span>
        <span className="mono dim">{grant.revokedAt ? `Revoked ${shortDate(grant.revokedAt)}` : `Until ${shortDate(grant.expiresAt)}`}</span>
        <div className="grant-actions">
          {grant.status === "invited" && <button className="text-button" disabled={busy === grant.id} onClick={() => void resend(grant)}>Resend email</button>}
          {live(grant) && grant.clearanceTier === 1 && <button className="secondary-button" disabled={busy === grant.id} onClick={() => void changeTier(grant, 2)}>Grant diligence</button>}
          {live(grant) && grant.clearanceTier === 2 && <button className="secondary-button" disabled={busy === grant.id} onClick={() => void changeTier(grant, 1)}>Set general</button>}
          {live(grant) && (confirmRevoke === grant.id
            ? <><button className="primary-button danger-button" disabled={busy === grant.id} onClick={() => void revoke(grant)}>Confirm revoke</button><button className="text-button" onClick={() => setConfirmRevoke(null)}>Cancel</button></>
            : <button className="text-button" onClick={() => setConfirmRevoke(grant.id)}>Revoke</button>)}
          {!live(grant) && <button className="text-button" onClick={() => { setEmail(grant.investorEmail); setFirm(grant.firmName ?? ""); setTier(grant.clearanceTier === 2 ? 2 : 1); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Re-invite</button>}
        </div>
      </div>)}
    </section>
  </section>;
}
