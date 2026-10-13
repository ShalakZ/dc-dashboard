import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { AppearanceProvider } from "../auth/AppearanceProvider";
import { AuthProvider } from "../auth/AuthProvider";
import { ToastContext, type ToastApi } from "../components/Toasts";
import "./routerRequestShim";

/** `toasts`: what `useToast()` returns inside the page, normally `spyToasts().api`. Without it a toast does nothing (the hook's default). */
export function renderWithProviders(ui: ReactElement, { route = "/", path = "*", toasts }: { route?: string; path?: string; toasts?: ToastApi } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const page = toasts ? <ToastContext.Provider value={toasts}>{ui}</ToastContext.Provider> : ui;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <AppearanceProvider>
            <Routes>
              <Route path={path} element={page} />
              <Route path="/login" element={<p>login page</p>} />
              <Route path="/setup" element={<p>setup page</p>} />
            </Routes>
          </AppearanceProvider>
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Like renderWithProviders, but under a data router (createMemoryRouter) as in production; `useBlocker` needs one.
 * `route` may carry router state ({ pathname, state }). The router is returned so a test can navigate and read the location.
 * /login, /setup, /assets and /dashboards render plain stubs ("login page", "assets page", ...) unless `path` is one of them.
 */
export function renderWithDataRouter(
  ui: ReactElement,
  { route = "/", path = "*", toasts }: { route?: string | { pathname: string; state?: unknown }; path?: string; toasts?: ToastApi } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const stubs = [["/login", "login page"], ["/setup", "setup page"], ["/assets", "assets page"], ["/dashboards", "dashboards page"]] as const;
  const page = toasts ? <ToastContext.Provider value={toasts}>{ui}</ToastContext.Provider> : ui;
  const router = createMemoryRouter(
    [{ path, element: page }, ...stubs.filter(([stubPath]) => stubPath !== path).map(([stubPath, text]) => ({ path: stubPath, element: <p>{text}</p> }))],
    { initialEntries: [route] },
  );
  const result = render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <AppearanceProvider>
          <RouterProvider router={router} />
        </AppearanceProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...result, router };
}
