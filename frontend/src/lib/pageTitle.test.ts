import { APP_TITLE, pageTitle } from "./pageTitle";

describe("pageTitle", () => {
  it.each([
    ["/assets", "Assets Tree"],
    ["/dashboards", "Dashboards"],
    ["/billing", "Billing"],
    ["/sources", "Sources"],
    ["/scans", "Scans"],
    ["/discovery", "Discovery"],
    ["/users", "Users & Roles"],
    ["/settings", "Settings"],
    ["/tariffs", "Tariffs"],
    ["/storage", "Storage"],
    ["/displays", "Displays"],
    ["/audit", "Audit log"],
    ["/events", "System events"],
    ["/events/42", "System events"], // the drawer of one event is the same page
    ["/diagnostics", "Diagnostics"],
    ["/password", "Change password"],
  ])("names %s %s, in front of the application's name", (path, page) => {
    expect(pageTitle(path)).toBe(`${page} · ${APP_TITLE}`);
  });

  it("covers everything below a page: an asset, a dashboard, a source's points, an audit entry", () => {
    expect(pageTitle("/assets/12")).toBe("Assets Tree · DC Dashboard");
    expect(pageTitle("/dashboards/3")).toBe("Dashboards · DC Dashboard");
    expect(pageTitle("/sources/4/points")).toBe("Sources · DC Dashboard");
    expect(pageTitle("/audit/99")).toBe("Audit log · DC Dashboard");
    expect(pageTitle("/users/roles")).toBe("Users & Roles · DC Dashboard"); // the Roles tab is the same page
    expect(pageTitle("/users/nonsense")).toBe("Users & Roles · DC Dashboard"); // an unknown tab shows Not found under this title: accepted
  });

  it("matches whole path segments: /assetsfoo is not the Assets Tree", () => {
    expect(pageTitle("/assetsfoo")).toBe("DC Dashboard");
    expect(pageTitle("/users-old")).toBe("DC Dashboard");
  });

  it("is the application's name alone for the home route and a path it does not know", () => {
    expect(pageTitle("/")).toBe("DC Dashboard");
    expect(pageTitle("/nowhere")).toBe("DC Dashboard");
    expect(APP_TITLE).toBe("DC Dashboard");
  });
});
