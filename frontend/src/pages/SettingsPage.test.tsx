import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mockFetch } from "../test/fetchMock";
import { holdFetch } from "../test/holdFetch";
import { renderWithProviders } from "../test/render";
import { SettingsPage } from "./SettingsPage";

const policy = (max_failures = 5, block_minutes = 5, enabled = true) => ({
  max_failures, block_minutes, enabled,
  limits: { max_failures: [3, 20], block_minutes: [1, 60] },
  defaults: { max_failures: 5, block_minutes: 5 },
});

const base = {
  "GET /api/setup": { body: { needed: false } },
  "GET /api/me": { body: { id: 1, username: "admin", role: "admin" } },
  "GET /api/settings/sign-in": { body: policy() },
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

  it("says what the zone decides: where a day and a month start, and the times shown", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
    const hint = screen.getByText(/Readings are stored in UTC/);
    expect(hint).toHaveTextContent("day");
    expect(hint).toHaveTextContent("month");
    expect(hint).toHaveTextContent("times");
    expect(hint).not.toHaveTextContent('Used for "today"');
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

describe("SettingsPage sign-in protection", () => {
  const section = () => screen.getByRole("form", { name: "Sign-in protection" });

  it("shows the stored numbers with the bounds the API gave, and the sentence that says what they do", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } }, "GET /api/settings/sign-in": { body: policy(7, 12) } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    const minutes = screen.getByLabelText("Block time in minutes");
    await waitFor(() => expect(failures).toHaveValue(7));
    expect(minutes).toHaveValue(12);
    expect(failures).toHaveAttribute("min", "3");
    expect(failures).toHaveAttribute("max", "20");
    expect(minutes).toHaveAttribute("min", "1");
    expect(minutes).toHaveAttribute("max", "60");
    expect(screen.getByRole("heading", { name: "Sign-in protection" })).toBeInTheDocument();
    expect(section()).toHaveTextContent(
      "After this many wrong passwords for one account from one computer, that account is blocked from that computer for this long. "
      + "Restarting the api service clears every block; Unblock on the Users page lets one account in sooner.",
    );
  });

  it("saves both numbers, shows saved, and leaves the timezone alone", async () => {
    let stored = policy();
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "GET /api/settings/sign-in": () => ({ body: stored }),
      "PUT /api/settings/sign-in": ({ body }) => {
        const b = body as { max_failures: number; block_minutes: number };
        stored = policy(b.max_failures, b.block_minutes);
        return { body: stored };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    await waitFor(() => expect(failures).toHaveValue(5));
    await userEvent.clear(failures);
    await userEvent.type(failures, "8");
    const minutes = screen.getByLabelText("Block time in minutes");
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "15");
    await userEvent.click(within(section()).getByRole("button", { name: "Save sign-in protection" }));
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => [c.path, c.body])).toEqual([
      ["/api/settings/sign-in", { max_failures: 8, block_minutes: 15, enabled: true }],
    ]);
    await waitFor(() => expect(screen.getByLabelText("Failed sign-ins before a block")).toHaveValue(8));
    expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
  });

  it("keeps the timezone form separate: its Save does not send the sign-in numbers", async () => {
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/general": { body: { timezone: "Asia/Qatar" } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const input = await screen.findByLabelText("Timezone");
    await userEvent.clear(input);
    await userEvent.type(input, "Asia/Qatar");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("saved")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT").map((c) => c.path)).toEqual(["/api/settings/general"]);
  });

  it("shows the API's text when the save is refused", async () => {
    mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "PUT /api/settings/sign-in": { status: 422, body: { detail: "block_minutes must be between 1 and 60" } },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    await waitFor(() => expect(failures).toHaveValue(5));
    await userEvent.click(within(section()).getByRole("button", { name: "Save sign-in protection" }));
    expect(await within(section()).findByRole("alert")).toHaveTextContent("block_minutes must be between 1 and 60");
    expect(within(section()).queryByText("saved")).not.toBeInTheDocument();
  });

  it("says so, in its own section, when the policy cannot be read; the timezone form still works", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "UTC" } }, "GET /api/settings/sign-in": { status: 500, body: { detail: "boom" } } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    expect(await screen.findByLabelText("Timezone")).toHaveValue("UTC");
    expect(await screen.findByRole("alert")).toHaveTextContent("boom");
    expect(screen.queryByLabelText("Failed sign-ins before a block")).not.toBeInTheDocument();
  });
});

describe("SettingsPage sign-in protection switch", () => {
  const SWITCH = "Block an account after repeated wrong passwords";
  const WARNING = /Sign-in protection is off\. Wrong passwords no longer block anyone/;
  const section = () => screen.getByRole("form", { name: "Sign-in protection" });

  /** A stateful sign-in endpoint: GET answers the stored policy, PUT stores it (like the API) and remembers the full URL. */
  function open(initial = policy(), putReply?: { status: number; body: unknown }) {
    let stored = initial;
    const urls: string[] = [];
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "GET /api/settings/sign-in": () => ({ body: stored }),
      "PUT /api/settings/sign-in": ({ url, body }) => {
        urls.push(url);
        if (putReply) return putReply;
        const b = body as { max_failures: number; block_minutes: number; enabled?: boolean };
        stored = policy(b.max_failures, b.block_minutes, b.enabled ?? true);
        return { body: stored };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const puts = () => calls.filter((c) => c.method === "PUT");
    return { calls, puts, urls };
  }
  const theSwitch = () => screen.findByRole("switch", { name: SWITCH });
  const save = () => userEvent.click(within(section()).getByRole("button", { name: "Save sign-in protection" }));

  it("shows the saved state as a switch inside the form, on, with no warning", async () => {
    open();
    const sw = await theSwitch();
    expect(sw).toBeChecked();
    expect(section()).toContainElement(sw);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(screen.queryByText("Used when protection is switched on.")).not.toBeInTheDocument();
  });

  it("shows OFF as an unchecked switch with a warning, and keeps the two numbers editable and filled", async () => {
    open(policy(7, 12, false));
    const sw = await theSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    const warning = screen.getByText(WARNING).closest("[role=status]");
    expect(warning).toHaveClass("banner", "banner-warn");
    expect(warning).toHaveTextContent("Switch it on again unless this is a closed, trusted network.");
    const failures = screen.getByLabelText("Failed sign-ins before a block");
    const minutes = screen.getByLabelText("Block time in minutes");
    expect(failures).toBeEnabled();
    expect(minutes).toBeEnabled();
    expect(failures).toHaveValue(7);
    expect(minutes).toHaveValue(12);
    expect(section()).toHaveTextContent("Used when protection is switched on.");
    await userEvent.clear(failures);
    await userEvent.type(failures, "9");
    expect(failures).toHaveValue(9);
  });

  it("treats a reply without `enabled` as ON", async () => {
    const { enabled: _enabled, ...old } = policy(6, 6);
    open(old as ReturnType<typeof policy>);
    const sw = await theSwitch();
    await waitFor(() => expect(screen.getByLabelText("Failed sign-ins before a block")).toHaveValue(6));
    expect(sw).toBeChecked();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
  });

  it("switching off shows the warning at once, but Save asks first and sends nothing yet", async () => {
    const { puts } = open();
    await userEvent.click(await theSwitch());
    expect(screen.getByRole("switch", { name: SWITCH })).not.toBeChecked();
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    await save();
    const dialog = await screen.findByRole("dialog", { name: "Stop blocking accounts?" });
    expect(within(dialog).getByRole("heading", { level: 2, name: "Stop blocking accounts?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "Wrong passwords will no longer block anyone, and accounts that are blocked now can sign in at once. The change is recorded in the Audit log.",
    );
    expect(puts()).toHaveLength(0);
  });

  it("Switch off sends one PUT with confirm=true and enabled:false, closes the dialog and shows saved", async () => {
    const { puts, urls } = open();
    await userEvent.click(await theSwitch());
    await save();
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Switch off" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(puts().map((c) => c.body)).toEqual([{ max_failures: 5, block_minutes: 5, enabled: false }]);
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0], "http://x").searchParams.get("confirm")).toBe("true");
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).not.toBeChecked());
    expect(screen.getByText(WARNING)).toBeInTheDocument();
  });

  it("Cancel puts the switch back to ON and sends nothing", async () => {
    const { puts } = open();
    await userEvent.click(await theSwitch());
    await save();
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked();
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(puts()).toHaveLength(0);
  });

  it("Escape does the same as Cancel", async () => {
    const { puts } = open();
    await userEvent.click(await theSwitch());
    await save();
    await screen.findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked();
    expect(puts()).toHaveLength(0);
  });

  it("an ON to ON save sends enabled:true and no confirm, with no dialog", async () => {
    const { puts, urls } = open();
    const failures = await screen.findByLabelText("Failed sign-ins before a block");
    await waitFor(() => expect(failures).toHaveValue(5));
    await userEvent.clear(failures);
    await userEvent.type(failures, "6");
    await save();
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(puts().map((c) => c.body)).toEqual([{ max_failures: 6, block_minutes: 5, enabled: true }]);
    expect(urls.map((u) => new URL(u, "http://x").search)).toEqual([""]);
  });

  it("switching back on saves enabled:true without a dialog or confirm", async () => {
    const { puts, urls } = open(policy(5, 5, false));
    const sw = await theSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    await userEvent.click(sw);
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    await save();
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(puts().map((c) => c.body)).toEqual([{ max_failures: 5, block_minutes: 5, enabled: true }]);
    expect(new URL(urls[0], "http://x").search).toBe("");
    await waitFor(() => expect(screen.getByRole("switch", { name: SWITCH })).toBeChecked());
  });

  it("saving the numbers while protection is already off sends enabled:false without confirm and asks nothing", async () => {
    const { puts, urls } = open(policy(5, 5, false));
    const minutes = await screen.findByLabelText("Block time in minutes");
    await waitFor(() => expect(minutes).toHaveValue(5));
    await userEvent.clear(minutes);
    await userEvent.type(minutes, "20");
    await save();
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(puts().map((c) => c.body)).toEqual([{ max_failures: 5, block_minutes: 20, enabled: false }]);
    expect(new URL(urls[0], "http://x").search).toBe("");
  });

  it("keeps the dialog open and shows the API's text when the confirmed save is refused", async () => {
    const { puts } = open(policy(), { status: 409, body: { detail: "this needs confirmation (send confirm=true)", needs_confirmation: true } });
    await userEvent.click(await theSwitch());
    await save();
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Switch off" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("this needs confirmation (send confirm=true)");
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(screen.getAllByRole("alert")).toHaveLength(1); // the form behind the dialog does not repeat it
    expect(puts()).toHaveLength(1);
  });

  it("a page that still shows OFF while the server says ON: the 409 brings the switch back to the server's state and the server's text stays", async () => {
    let stored = policy(5, 5, false);
    const text = "Sign-in protection is on. Switching it off needs confirmation: reload the Settings page and switch it off again.";
    const calls = mockFetch({
      ...base,
      "GET /api/settings/general": { body: { timezone: "UTC" } },
      "GET /api/settings/sign-in": () => ({ body: stored }),
      "PUT /api/settings/sign-in": () => {
        stored = policy(5, 5, true); // someone switched it on in the meantime
        return { status: 409, body: { detail: text, needs_confirmation: true } };
      },
    });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    const sw = await theSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    expect(screen.getByText(WARNING)).toBeInTheDocument();
    await save(); // OFF to OFF: no dialog, sent without confirm
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(sw).toBeChecked());
    expect(screen.queryByText(WARNING)).not.toBeInTheDocument();
    expect(within(section()).getByRole("alert")).toHaveTextContent(text);
    expect(calls.filter((c) => c.method === "GET" && c.path === "/api/settings/sign-in")).toHaveLength(2);
  });

  it("clears the saved marker when the switch is touched", async () => {
    open(policy(5, 5, false));
    const sw = await theSwitch();
    await waitFor(() => expect(sw).not.toBeChecked());
    await save();
    expect(await within(section()).findByText("saved")).toBeInTheDocument();
    await userEvent.click(sw);
    expect(within(section()).queryByText("saved")).not.toBeInTheDocument();
  });
});

describe("SettingsPage certificate line", () => {
  const tls = (over: Record<string, unknown>) => ({
    enabled: true, state: "ok", not_after: "2026-11-09T11:03:11+00:00", days_left: 80, subject: "CN=dcdash.example",
    checked_at: "2026-10-10T12:00:00+00:00", error: null, ...over,
  });

  /** Opens the page and returns once the certificate status has been asked for and the page is showing. */
  async function open(reply: { status?: number; body: unknown }) {
    const calls = mockFetch({ ...base, "GET /api/settings/general": { body: { timezone: "Asia/Qatar" } }, "GET /api/tls/status": reply });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
    await waitFor(() => expect(calls.some((c) => c.path === "/api/tls/status")).toBe(true));
  }

  it("shows a read-only Certificate line with the expiry on the site clock when a certificate is configured", async () => {
    await open({ body: tls({}) });
    const line = await screen.findByText(/Certificate/);
    expect(line).toHaveTextContent("expires 2026-11-09 14:03:11 (80 days left)");
    expect(line).toHaveTextContent("CN=dcdash.example");
    expect(line.querySelector("input, button")).toBeNull();
  });

  it("says when the certificate has expired", async () => {
    await open({ body: tls({ state: "expired", days_left: 0 }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("expired on 2026-11-09 14:03:11");
  });

  it("shows the reason when the certificate file cannot be read", async () => {
    await open({ body: tls({ state: "unreadable", not_after: null, days_left: null, subject: null, error: "permission denied" }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("cannot be read: permission denied");
  });

  it("says the collector has not checked lately when the state is unknown", async () => {
    await open({ body: tls({ state: "unknown", not_after: null, days_left: null, subject: null }) });
    expect(await screen.findByText(/Certificate/)).toHaveTextContent("not checked recently");
  });

  it("shows no Certificate line when HTTPS is not configured", async () => {
    await open({ body: { enabled: false, state: null, not_after: null, days_left: null, subject: null, checked_at: null, error: null } });
    expect(screen.queryByText(/Certificate/)).not.toBeInTheDocument();
  });

  it("shows no Certificate line when the status cannot be fetched", async () => {
    await open({ status: 500, body: { detail: "boom" } });
    expect(screen.queryByText(/Certificate/)).not.toBeInTheDocument();
  });
});

describe("SettingsPage version line", () => {
  async function open(version: { status?: number; body: unknown }, timezone = "UTC") {
    mockFetch({ ...base, "GET /api/settings/general": { body: { timezone } }, "GET /api/version": version });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    await screen.findByLabelText("Timezone");
  }

  it("shows the build id and the commit time on the site clock, as plain text", async () => {
    await open({ body: { build_id: "227bd6a", build_time: "2026-10-12T14:03:11+02:00", uptime_seconds: 5.2 } }, "Asia/Qatar");
    const line = await screen.findByText(/^Version /);
    expect(line).toHaveTextContent("Version 227bd6a, built 2026-10-12 15:03:11");
    expect(line.querySelector("input, button")).toBeNull();
  });

  it("says dev and unknown for an image built without a build id", async () => {
    await open({ body: { build_id: "dev", build_time: "unknown", uptime_seconds: 1 } });
    expect(await screen.findByText(/^Version /)).toHaveTextContent("Version dev, built unknown");
  });

  it("shows no version line when the version cannot be read, and the rest of the page works", async () => {
    await open({ status: 500, body: { detail: "boom" } });
    expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
    expect(screen.getByLabelText("Timezone")).toHaveValue("UTC");
  });
});

describe("SettingsPage while it loads (W7f)", () => {
  const general = { "GET /api/settings/general": { body: { timezone: "UTC" } } };
  const mount = (held: string) => {
    mockFetch({ ...base, ...general });
    const hold = holdFetch((_method, path) => path === held);
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    return hold;
  };

  it("shows the page's wrapper, the real header and the two-column grid of form skeletons in one region while the settings are held, then the page", async () => {
    const hold = mount("/api/settings/general");
    const page = document.querySelector("section.admin-page.settings-page")!;
    expect(page).not.toBeNull();
    expect(within(page as HTMLElement).getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const region = screen.getByText("Loading settings").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveClass("settings-grid"); // the region IS the grid, so the cards sit where the real ones do
    expect(region.querySelectorAll(":scope > .settings-col > .form-card, :scope > .form-card")).toHaveLength(2);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Timezone")).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByLabelText("Timezone")).toBeInTheDocument();
    expect(screen.queryByText("Loading settings")).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("shows the sign-in card's own wait inside its real card and heading, with two field rows and no card of its own, then the form", async () => {
    const hold = mount("/api/settings/sign-in");
    await screen.findByLabelText("Timezone"); // the general settings are in; the policy is not
    const card = screen.getByRole("heading", { name: "Sign-in protection" }).closest(".form-card")!;
    const region = within(card as HTMLElement).getByText("Loading sign-in protection").parentElement!;
    expect(region).toHaveAttribute("role", "status");
    expect(region.querySelectorAll(".sk-field")).toHaveLength(2);
    expect(card.querySelectorAll(".form-card")).toHaveLength(0);
    expect(screen.queryByText("loading…")).not.toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Sign-in protection" })).not.toBeInTheDocument();
    hold.release();
    expect(await screen.findByRole("form", { name: "Sign-in protection" })).toBeInTheDocument();
    expect(screen.queryByText("Loading sign-in protection")).not.toBeInTheDocument();
    expect(document.querySelector(".sk-region")).toBeNull();
  });

  it("ends with the error alone when the settings fail, and with the error inside the sign-in card when only the policy fails, never a region", async () => {
    mockFetch({ ...base, "GET /api/settings/general": { status: 500, body: { detail: "settings are down" } } });
    const first = renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    expect(await screen.findByRole("alert")).toHaveTextContent("settings are down");
    expect(document.querySelector(".sk-region")).toBeNull();
    first.unmount();
    mockFetch({ ...base, ...general, "GET /api/settings/sign-in": { status: 500, body: { detail: "policy is down" } } });
    renderWithProviders(<SettingsPage />, { route: "/settings", path: "/settings" });
    expect(await screen.findByRole("alert")).toHaveTextContent("policy is down");
    expect(document.querySelector(".sk-region")).toBeNull();
  });
});
