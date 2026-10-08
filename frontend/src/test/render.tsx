import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { createMemoryRouter, MemoryRouter, Route, RouterProvider, Routes } from "react-router";
import { AuthProvider } from "../auth/AuthProvider";

export function renderWithProviders(ui: ReactElement, { route = "/", path = "*" } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AuthProvider>
          <Routes>
            <Route path={path} element={ui} />
            <Route path="/login" element={<p>login page</p>} />
            <Route path="/setup" element={<p>setup page</p>} />
          </Routes>
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
  { route = "/", path = "*" }: { route?: string | { pathname: string; state?: unknown }; path?: string } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const stubs = [["/login", "login page"], ["/setup", "setup page"], ["/assets", "assets page"], ["/dashboards", "dashboards page"]] as const;
  const router = createMemoryRouter(
    [{ path, element: ui }, ...stubs.filter(([stubPath]) => stubPath !== path).map(([stubPath, text]) => ({ path: stubPath, element: <p>{text}</p> }))],
    { initialEntries: [route] },
  );
  const result = render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <RouterProvider router={router} />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...result, router };
}
