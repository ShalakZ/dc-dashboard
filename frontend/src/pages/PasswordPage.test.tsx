import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { PasswordPage } from "./PasswordPage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: userFor("viewer", { id: 5, username: "v" }) },
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

  it("submits and confirms with one toast (no loose paragraph), or shows the 401 message and raises none", async () => {
    const calls = mockFetch({
      ...base,
      "POST /api/me/password": ({ body }) =>
        (body as { current_password: string }).current_password === "correct-horse"
          ? { status: 204 }
          : { status: 401, body: { detail: "current password is incorrect" } },
    });
    const toasts = spyToasts();
    renderWithProviders(<PasswordPage />, { route: "/password", path: "/password", toasts: toasts.api });
    await userEvent.type(await screen.findByLabelText("Current password"), "wrong");
    await userEvent.type(screen.getByLabelText("New password"), "newpassword1");
    await userEvent.type(screen.getByLabelText("Repeat new password"), "newpassword1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("current password is incorrect")).toBeInTheDocument();
    expect(toasts.calls).toEqual([]);
    await userEvent.clear(screen.getByLabelText("Current password"));
    await userEvent.type(screen.getByLabelText("Current password"), "correct-horse");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() => expect(toasts.calls).toEqual([{ kind: "success", text: "Password changed. Other sessions were signed out." }]));
    expect(screen.queryByText("Password changed. Other sessions were signed out.")).not.toBeInTheDocument(); // the toast is the one feedback
    expect(screen.getByLabelText("Current password")).toHaveValue(""); // the fields clear
    expect(calls.filter((c) => c.path === "/api/me/password").length).toBe(2);
  });
});
