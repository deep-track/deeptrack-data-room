import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Auth0Provider, useAuth0 } from "@auth0/auth0-react";
import App from "./App";
import { auth0Config, isAuth0Configured } from "./auth0-config";
import "./styles.css";
import "./login-layout.css";

function AuthenticatedApp() {
  const auth0 = useAuth0();
  return <App auth0={auth0} />;
}

function AuthConfigurationError() {
  return <main className="login-page"><section className="login-card-wrap"><div className="login-card"><p className="eyebrow">Secure entry unavailable</p><h1>Authentication is not configured</h1><p className="login-note">This data room is fail-closed. An Auth0 deployment configuration is required before any identity can access the review environment.</p><p className="login-footnote">Contact Deeptrack Investor Relations or the deployment administrator.</p></div></section></main>;
}

function Root() {
  const reviewPreviewEnabled = import.meta.env.DEV && import.meta.env.VITE_ENABLE_REVIEW_PREVIEW === "true";
  if (!isAuth0Configured && !reviewPreviewEnabled) return <AuthConfigurationError />;
  if (!isAuth0Configured) return <App />;
  return (
    <Auth0Provider
      domain={auth0Config.domain}
      clientId={auth0Config.clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Config.audience,
        scope: "openid profile email offline_access",
        ...(auth0Config.organization ? { organization: auth0Config.organization } : {}),
      }}
      useRefreshTokens
      useRefreshTokensFallback
      cacheLocation="memory"
    >
      <AuthenticatedApp />
    </Auth0Provider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
