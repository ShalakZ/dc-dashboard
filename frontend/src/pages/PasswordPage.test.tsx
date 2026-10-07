import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { PasswordPage } from "./PasswordPage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 5, username: "v", role: "viewer" } },
};

describe("PasswordPage", () => {
  it("refuses mismatched passwords without calling the API", async () => {
    const calls = mockFetch(base);
    renderWithProviders(<PasswordPage />, { route: "/password", path: "/password" });
    await userEvent.type(await screen.findByLabelText("Current password"), "correct-horse");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "newpassword2");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("passwords do not match")).toBeInTheDocument();
    expect(calls.some((c) => c.path === "/api/me/password")).toBe(false);
  });

  it("submits and shows the confirmation, or the 401 message", async () => {
    const calls = mockFetch({
      ...base,
      "POST /api/me/password": ({ body }) =>
        (body as { current_password: string }).current_password === "correct-horse"
          ? { status: 204 }
          : { status: 401, body: { detail: "current password is incorrect" } },
    });
    renderWithProviders(<PasswordPage />, { route: "/password", path: "/password" });
    await userEvent.type(await screen.findByLabelText("Current password"), "wrong");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("current password is incorrect")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Current password"));
    await userEvent.type(screen.getByLabelText("Current password"), "correct-horse");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Password changed. Other sessions were signed out.")).toBeInTheDocument();
    expect(calls.filter((c) => c.path === "/api/me/password").length).toBe(2);
  });
});
