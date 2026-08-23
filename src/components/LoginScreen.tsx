import { ArrowRight, BadgeCheck, LockKeyhole, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { reviewRoleAccess, roleDetails, type DataRoomRole, type ReviewSession } from "../auth";
import type { Auth0Bridge } from "../auth0-config";

type Props = { onContinue: (session: ReviewSession) => void; auth0?: Auth0Bridge | null };

export function LoginScreen({ onContinue, auth0 = null }: Props) {
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

  if (auth0) return <main className="login-page"><section className="login-left"><div className="login-brand"><span>///</span><strong>deeptrack</strong></div><p className="eyebrow">Investor relations</p><h1>A controlled record for material diligence.</h1><p className="login-lead">Sign in with your organisation-approved identity to access the Deeptrack data room.</p><div className="security-points"><div><LockKeyhole size={18} /><span>Auth0 verifies identity and organisation membership.</span></div><div><ShieldCheck size={18} /><span>Server-side permissions govern clearance and document access.</span></div><div><BadgeCheck size={18} /><span>Investor access remains read-only and auditable.</span></div></div></section><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Secure entry</p><h2>Sign in to the data room</h2><p className="login-note">Use your approved Auth0 identity. Founder and Investor Relations privileges are granted by server-side role claims, never by an email typed into the browser.</p><button className="primary-button login-submit" type="button" onClick={() => void auth0.loginWithRedirect()}>Continue with Auth0 <ArrowRight size={16} /></button></div><p className="login-footnote">Deeptrack Data Room · Confidential review environment</p></section></main>;

  return <main className="login-page"><section className="login-left"><div className="login-brand"><span>///</span><strong>deeptrack</strong></div><p className="eyebrow">Investor relations</p><h1>A controlled record for material diligence.</h1><p className="login-lead">This role-aware preview demonstrates the data-room experience for Founder, Investor Relations, and investor participants.</p><div className="security-points"><div><LockKeyhole size={18} /><span>Role, clearance, NDA, and expiry checks belong to the production server.</span></div><div><ShieldCheck size={18} /><span>Private storage and audit events remain required before live investor use.</span></div><div><BadgeCheck size={18} /><span>Founder and Investor Relations are administrators; investors remain read-only.</span></div></div></section><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Secure entry</p><h2>Enter the review environment</h2><p className="login-note">{restrictedIdentity ? `${detail.label} review entry is reserved for ${restrictedIdentity.displayName} using ${restrictedIdentity.email}. This preview checks the address only; production must verify identity server-side.` : "Investor review is open to valid personal and business email addresses. Production sign-in must still verify identity with an approved identity provider, MFA, and server-side sessions."}</p><form onSubmit={submit}><fieldset><legend>Choose a role to review</legend><div className="role-options">{(Object.keys(roleDetails) as DataRoomRole[]).map((item) => <label key={item} className={`role-option ${role === item ? "selected" : ""}`}><input type="radio" name="role" checked={role === item} onChange={() => { setRole(item); setError(""); }} /><span><strong>{roleDetails[item].label}</strong><small>{roleDetails[item].description}</small></span></label>)}</div></fieldset><label className="login-field"><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" autoComplete="name" /></label><label className="login-field"><span>{restrictedIdentity ? "Authorized email" : "Email address"}</span><input value={email} onChange={(event) => setEmail(event.target.value)} placeholder={restrictedIdentity?.email ?? "name@gmail.com or name@company.com"} type="email" autoComplete="email" /></label>{error && <p className="form-error" role="alert">{error}</p>}<button className="primary-button login-submit" type="submit">Continue in review mode <ArrowRight size={16} /></button></form></div><p className="login-footnote">Deeptrack Data Room · Confidential review environment</p></section></main>;
}
