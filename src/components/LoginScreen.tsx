import { ArrowRight, BadgeCheck, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { reviewRoleAccess, roleDetails, type DataRoomRole, type ReviewSession } from "../auth";

type Props = { onContinue: (session: ReviewSession) => void };

export function LoginScreen({ onContinue }: Props) {
  const [role, setRole] = useState<DataRoomRole>("investor");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const detail = roleDetails[role];
  const restrictedIdentity = reviewRoleAccess[role];

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim() || !email.trim() || !email.includes("@")) return setError("Enter a name and a valid email address to continue in review mode.");
    const normalizedEmail = email.trim().toLowerCase();
    if (restrictedIdentity && normalizedEmail !== restrictedIdentity.email) return setError(`${detail.label} review entry is reserved for ${restrictedIdentity.displayName} using ${restrictedIdentity.email}. Choose Investor for an open review session.`);
    onContinue({ role, displayName: restrictedIdentity?.displayName ?? name.trim(), email: normalizedEmail, clearanceTier: detail.clearanceTier });
  }

  return <main className="login-page"><section className="login-left"><div className="login-brand"><span>///</span><strong>deeptrack</strong></div><p className="eyebrow">Investor relations</p><h1>A controlled record for material diligence.</h1><p className="login-lead">This role-aware preview demonstrates the data-room experience for Founder, Investor Relations, and investor participants.</p><div className="security-points"><div><LockKeyhole size={18} /><span>Role, clearance, NDA, and expiry checks belong to the production server.</span></div><div><ShieldCheck size={18} /><span>Private storage and audit events remain required before live investor use.</span></div><div><BadgeCheck size={18} /><span>Founder and Investor Relations are administrators; investors remain read-only.</span></div></div></section><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Secure entry</p><h2>Enter the review environment</h2><p className="login-note">{restrictedIdentity ? `${detail.label} review entry is reserved for ${restrictedIdentity.displayName} using ${restrictedIdentity.email}. This preview checks the address only; production must verify identity server-side.` : "Investor review is open to valid personal and business email addresses. Production sign-in must still verify identity with an approved identity provider, MFA, and server-side sessions."}</p><form onSubmit={submit}><fieldset><legend>Choose a role to review</legend><div className="role-options">{(Object.keys(roleDetails) as DataRoomRole[]).map((item) => <label key={item} className={`role-option ${role === item ? "selected" : ""}`}><input type="radio" name="role" checked={role === item} onChange={() => { setRole(item); setError(""); }} /><span><strong>{roleDetails[item].label}</strong><small>{roleDetails[item].description}</small></span></label>)}</div></fieldset><label className="login-field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" /></label><label className="login-field"><span>{restrictedIdentity ? "Authorized email" : "Email address"}</span><input value={email} onChange={(event) => setEmail(event.target.value)} placeholder={restrictedIdentity?.email ?? "name@gmail.com or name@company.com"} type="email" autoComplete="email" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button login-submit" type="submit">Continue in review mode <ArrowRight size={16} /></button></form></div><p className="login-footnote">Deeptrack Data Room · Confidential review environment</p></section></main>;
}
