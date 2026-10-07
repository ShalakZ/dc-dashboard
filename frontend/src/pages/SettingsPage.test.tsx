import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SettingsPage } from "./SettingsPage";

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
};

describe("SettingsPage", () => {
  it("loads, saves a timezone and shows the saved marker", async () => {
    let tz = "UTC";
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": () => ({ body: { timezone: tz } }),
      "PUT /api/settings/general": ({ body }) => {
        tz = (body as { timezone: string }).timezone;
        return { body: { timezone: tz } };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    expect(input).toHaveValue("UTC");
    await userEvent.clear(input);
    await userEvent.type(input, "Europe/Amsterdam");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({ timezone: "Europe/Amsterdam" });
  });

  it("shows the API message for an unknown timezone", async () => {
    mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/general": { status: 422, body: { detail: [{ msg: "Value error, unknown timezone: Mars/Olympus" }] } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    await userEvent.clear(input);
    await userEvent.type(input, "Mars/Olympus");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText(/unknown timezone: Mars\/Olympus/)).toBeInTheDocument();
  });
});
