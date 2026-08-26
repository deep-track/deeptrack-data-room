/**
 * Auth0 Post-Login Action for Deeptrack Data Room.
 *
 * Elevated roles are assigned only to approved, verified identities. Every
 * other authenticated user receives the least-privileged Investor role.
 * The backend remains authoritative for company grants, clearance tiers,
 * document visibility, upload, and publication permissions.
 */
exports.onExecutePostLogin = async (event, api) => {
  const email = String(event.user.email || "").trim().toLowerCase();
  const verified = event.user.email_verified === true;

  let roles = ["investor"];
  if (verified && email === "bryan@deeptrack.io") {
    roles = ["founder"];
  } else if (verified && email === "ygachara@deeptrack.io") {
    roles = ["investorRelations"];
  }

  const claim = "https://deeptrack.io/roles";
  api.idToken.setCustomClaim(claim, roles);
  api.accessToken.setCustomClaim(claim, roles);
};
