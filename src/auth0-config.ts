export type Auth0User = {
  sub?: string;
  name?: string;
  email?: string;
  [claim: string]: unknown;
};

export type Auth0Bridge = {
  isLoading: boolean;
  isAuthenticated: boolean;
  user?: Auth0User;
  loginWithRedirect: () => Promise<void>;
  logout: (options?: { logoutParams?: { returnTo?: string } }) => void;
  getAccessTokenSilently: (options?: { authorizationParams?: { audience?: string } }) => Promise<string>;
};

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN?.trim() || "",
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() || "",
  audience: import.meta.env.VITE_AUTH0_AUDIENCE?.trim() || "",
  organization: import.meta.env.VITE_AUTH0_ORGANIZATION_ID?.trim() || undefined,
};

export const isAuth0Configured = Boolean(auth0Config.domain && auth0Config.clientId && auth0Config.audience);

const roleClaim = import.meta.env.VITE_AUTH0_ROLE_CLAIM?.trim() || "https://deeptrack.io/roles";

export function sessionFromAuth0(user: Auth0User) {
  const raw = user[roleClaim] ?? user["https://deeptrack.io/role"];
  const roles = Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : typeof raw === "string" ? [raw] : [];
  const role = roles.some((value) => ["founder", "owner", "head"].includes(value)) ? "founder" : roles.some((value) => ["investorRelations", "investor_relations", "investor-relations", "admin"].includes(value)) ? "investorRelations" : "investor";
  return { role, displayName: user.name || user.email || "Authenticated user", email: user.email || "", clearanceTier: role === "investor" ? 1 : 3 } as const;
}
