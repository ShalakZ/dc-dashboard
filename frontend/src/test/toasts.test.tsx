import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useToast } from "../components/Toasts";
import { mockFetch } from "./fetchMock";
import { renderWithDataRouter, renderWithProviders } from "./render";
import { spyToasts } from "./toasts";

// A page stand-in with one button that raises two toasts.
function Page() {
  const toast = useToast();
  return <button type="button" onClick={() => { toast.success("Rate added"); toast.error("Nope"); }}>go</button>;
}

const routes = { "GET /api/setup": { body: { needed: false } }, "GET /api/me": { status: 401, body: { detail: "no" } } };

describe("spyToasts", () => {
  it("records what a page raises, through renderWithProviders({ toasts })", async () => {
    mockFetch(routes);
    const { api, calls } = spyToasts();
    renderWithProviders(<Page />, { toasts: api });
    await waitFor(() => expect(screen.getByRole("button", { name: "go" })).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "go" }));
    expect(calls).toEqual([{ kind: "success", text: "Rate added" }, { kind: "error", text: "Nope" }]);
  });

  it("records through renderWithDataRouter({ toasts }) too", async () => {
    mockFetch(routes);
    const { api, calls } = spyToasts();
    renderWithDataRouter(<Page />, { toasts: api });
    await userEvent.click(await screen.findByRole("button", { name: "go" }));
    expect(calls.map((c) => c.text)).toEqual(["Rate added", "Nope"]);
  });

  it("records through wrap(ui), and a page rendered without it raises nothing anywhere", async () => {
    mockFetch(routes);
    const { calls, wrap } = spyToasts();
    renderWithProviders(wrap(<Page />));
    await userEvent.click(await screen.findByRole("button", { name: "go" }));
    expect(calls).toHaveLength(2);
    renderWithProviders(<Page />);
    await userEvent.click((await screen.findAllByRole("button", { name: "go" }))[1]);
    expect(calls).toHaveLength(2);
  });
});
