import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { mockFetch } from "../test/fetchMock";
import { usePatchUser, useUsers } from "./queries";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("user queries", () => {
  it("lists users and refetches after a patch", async () => {
    let active = true;
    const calls = mockFetch({
      "GET /api/users": () => ({ body: [{ id: 2, username: "ops", role: "operator", active }] }),
      "PATCH /api/users/2": ({ body }) => { active = (body as { active: boolean }).active; return { body: { id: 2, username: "ops", role: "operator", active } }; },
    });
    const { result } = renderHook(() => ({ users: useUsers(), patch: usePatchUser() }), { wrapper });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(true));
    await result.current.patch.mutateAsync({ id: 2, body: { active: false } });
    await waitFor(() => expect(result.current.users.data?.[0].active).toBe(false));
    expect(calls.filter((c) => c.path === "/api/users").length).toBe(2);
  });
});
