import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import "./app.css";
import "./themes.css";
import "./styles/widgets.css";
import "./styles/widgets-details.css";
import "./styles/pages-assets.css";
import "./styles/pages-sources.css";
import "./styles/pages-billing.css";
import "./styles/pages-admin.css";
import "./styles/pages-auth.css";
import "./styles/feedback-save.css";
import "./styles/feedback-toasts.css";
import "./styles/feedback-confirm.css";
import "./styles/drawer.css";
import "./styles/role-prompt.css";
import "./styles/icon-picker.css";
import "./styles/kinds-dialogs.css";
import "./styles/tree-move.css";
import "./styles/asset-move.css";
import "./styles/scans-drawer.css";
import "./styles/discovery-tidy.css";
import "./styles/bulk-assets.css";
import "./styles/scans-polish.css";
import "./styles/graph-nodes.css";
import "./styles/graph-tools.css";
import "./styles/graph-keys.css";
import "./styles/graph-source-card.css";
import "./styles/graph-value-tip.css";
import "./styles/month-check.css";
import "./styles/asset-picker.css";
import "./styles/focus-follow.css";
import "./styles/focus-header.css";
import "./styles/focus-drill.css";
import "./styles/templates.css";
import "./styles/dashboard-guide.css";
import "./styles/displays.css";
import { App } from "./App";
import { AppearanceProvider } from "./auth/AppearanceProvider";
import { AuthProvider } from "./auth/AuthProvider";
import { RouteError } from "./components/RouteError";
import { ToastProvider } from "./components/Toasts";
import { DisplayApp } from "./display/DisplayApp";
import { isDisplayPath } from "./display/isDisplayPath";
import { reloadOnLink } from "./display/reloadOnLink";
import { holdSecret } from "./display/secretHandle";
import { takeFragment } from "./display/takeFragment";
import { installChunkReload } from "./lib/chunkReload";

function mountApp() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

  // A tab left open across an update reloads once when a lazy chunk it needs is gone (a second failure within 10 s does not loop).
  installChunkReload();

  // A data router, because useBlocker (unsaved dashboard edits) only works under one. A single catch-all route keeps
  // App's own <Routes> tree (in App.tsx) exactly as it is. Its errorElement replaces React Router's developer error page.
  const router = createBrowserRouter([{ path: "*", element: <App />, errorElement: <RouteError /> }]);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <AppearanceProvider>
            <ToastProvider>
              <RouterProvider router={router} />
            </ToastProvider>
          </AppearanceProvider>
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}

// A display screen (w28) is not the app: no sign-in, no providers, no router and no chunk reload ever exist on its page. The secret of its
// link is taken out of the address first, synchronously, before anything is mounted or requested; it must be a full page load
// (nothing in the app links here with a router Link, which would skip this branch). The screen gets a handle, never the string: the claim
// releases the secret at its first definite answer, and no variable here holds it.
if (isDisplayPath(window.location.pathname)) {
  const handle = holdSecret(takeFragment());
  // A link opened in this same tab changes only the fragment (no page load, no claim, the secret stays in the address bar): load the page again.
  reloadOnLink();
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <DisplayApp handle={handle} />
    </StrictMode>,
  );
} else {
  mountApp();
}
