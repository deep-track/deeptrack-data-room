import { resolveDataRoomRole } from "./auth0-roles";

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

function optionalAuth0Organization(value: unknown) {
  const organization = typeof value === "string" ? value.trim() : "";
  if (!organization || organization.startsWith("replace-with-") || organization.startsWith("<")) return undefined;
  return organization;
}

export const auth0Config = {
  domain: import.meta.env.VITE_AUTH0_DOMAIN?.trim() || "",
  clientId: import.meta.env.VITE_AUTH0_CLIENT_ID?.trim() || "",
  audience: import.meta.env.VITE_AUTH0_AUDIENCE?.trim() || "",
  organization: optionalAuth0Organization(import.meta.env.VITE_AUTH0_ORGANIZATION_ID),
};

export const isAuth0Configured = Boolean(auth0Config.domain && auth0Config.clientId && auth0Config.audience);

const roleClaim = import.meta.env.VITE_AUTH0_ROLE_CLAIM?.trim() || "https://deeptrack.io/roles";
export function sessionFromAuth0(user: Auth0User) {
  const raw = user[roleClaim] ?? user["https://deeptrack.io/role"];
  const resolved = resolveDataRoomRole({
    email: user.email,
    roles: raw,
  }, {
    founderEmails: import.meta.env.VITE_AUTH0_FOUNDER_EMAILS,
    investorRelationsEmails: import.meta.env.VITE_AUTH0_INVESTOR_RELATIONS_EMAILS,
  });
  return { role: resolved.role, displayName: user.name || user.email || "Authenticated user", email: user.email || "", clearanceTier: resolved.clearanceTier } as const;
}
