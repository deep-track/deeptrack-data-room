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

function Root() {
  if (!isAuth0Configured) return <App />;
  return (
    <Auth0Provider
      domain={auth0Config.domain}
      clientId={auth0Config.clientId}
      authorizationParams={{
        redirect_uri: window.location.origin,
        audience: auth0Config.audience,
        ...(auth0Config.organization ? { organization: auth0Config.organization } : {}),
      }}
      useRefreshTokens
      cacheLocation="memory"
    >
      <AuthenticatedApp />
    </Auth0Provider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
