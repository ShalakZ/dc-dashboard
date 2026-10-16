import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { keys, useAssets } from "../api/queries";
import type { Asset, AssetIn } from "../api/types";
import type { PermissionId } from "../lib/permissions";
import { CacheProbes, probeFetches, probeRoutes } from "../test/cacheProbes";
import { mockFetch, type Routes } from "../test/fetchMock";
import { renderWithProviders } from "../test/render";
import { SignedIn, accountKnown } from "../test/signedIn";
import { spyToasts } from "../test/toasts";
import { userFor } from "../test/users";
import { useCreateAsset } from "./useCreateAsset";

const CREATED: Asset = { id: 9, parent_id: 1, name: "Pump 1", kind: "Pump", sort_order: 0, icon: "pump" };
const BODY: AssetIn = { name: "Pump 1", parent_id: 1, kind: "Pump", sort_order: 0, icon: "pump" };

/** What a page does around the hook: it keeps the asset list mounted (so a refresh is a request) and calls `create` from a button. */
function Harness({ registerKind, also }: { registerKind: boolean; also?: readonly (readonly unknown[])[] }) {
  useAssets();
  const create = useCreateAsset(also ? { also } : undefined);
  const [outcome, setOutcome] = useState("none");
  return (
    <div>
      <SignedIn />
      <CacheProbes />
      <button type="button" onClick={() => { create(BODY, registerKind).then((a) => setOutcome(`created ${a.id}`), (e: Error) => setOutcome(`rejected ${e.message}`)); }}>create</button>
      <span data-testid="outcome">{outcome}</span>
    </div>
  );
}

const authed = (permissions?: PermissionId[]): Routes => ({
  "GET /api/me": { body: permissions ? userFor("custom", { permissions }) : userFor("admin") },
  "GET /api/setup": { body: { needed: false } },
  "GET /api/assets": { body: [] },
  ...probeRoutes,
});
const outcome = () => screen.getByTestId("outcome").textContent;
const count = (calls: { method: string; path: string }[], method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length;

async function run(routes: Routes, props: { registerKind: boolean; also?: readonly (readonly unknown[])[] }) {
  const calls = mockFetch(routes);
  const spy = spyToasts();
  renderWithProviders(<Harness {...props} />, { toasts: spy.api });
  await accountKnown();
  await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(1));
  await userEvent.click(screen.getByRole("button", { name: "create" }));
  return { calls, spy };
}

describe("useCreateAsset", () => {
  it("posts the body as the form built it (the icon it chose, the kind it typed) and answers with the created asset", async () => {
    const { calls } = await run({ ...authed(), "POST /api/assets": { body: CREATED } }, { registerKind: false });
    await waitFor(() => expect(outcome()).toBe("created 9"));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/assets").map((c) => c.body)).toEqual([BODY]);
  });

  it("toasts Asset created right after the request, before anything is refreshed", async () => {
    const spy = spyToasts();
    let posted = false;
    let toastsAtRefresh: number | null = null;
    const calls = mockFetch({
      ...authed(),
      "POST /api/assets": () => { posted = true; return { body: CREATED }; },
      "GET /api/assets": () => {
        if (posted && toastsAtRefresh === null) toastsAtRefresh = spy.calls.length;
        return { body: [] };
      },
    });
    renderWithProviders(<Harness registerKind={false} />, { toasts: spy.api });
    await accountKnown();
    await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(1));
    await userEvent.click(screen.getByRole("button", { name: "create" }));
    await waitFor(() => expect(outcome()).toBe("created 9"));
    expect(spy.calls).toEqual([{ kind: "success", text: "Asset created" }]);
    expect(toastsAtRefresh).toBe(1); // the refresh happened, and the toast was already there when it started
  });

  it("refreshes the assets and the fleet when no kind is registered, and sends no kind request", async () => {
    const { calls } = await run({ ...authed(), "POST /api/assets": { body: CREATED } }, { registerKind: false });
    await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(2));
    expect(count(calls, "POST", "/api/asset-kinds")).toBe(0);
  });

  it("registers a new kind with the icon the guess gives, for a person with assets.kinds, and the kind request refreshes the lists itself", async () => {
    const { calls } = await run({ ...authed(), "POST /api/assets": { body: CREATED }, "POST /api/asset-kinds": { status: 201, body: { id: 3, name: "Pump", icon: "pump", asset_count: 1, starter: false } } }, { registerKind: true });
    await waitFor(() => expect(outcome()).toBe("created 9"));
    expect(calls.filter((c) => c.method === "POST" && c.path === "/api/asset-kinds").map((c) => c.body)).toEqual([{ name: "Pump", icon: "pump" }]);
    await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(2)); // one round, not two: the kind mutation refreshes, the hook does not ask again
    await new Promise((r) => setTimeout(r, 30));
    expect(count(calls, "GET", "/api/assets")).toBe(2);
  });

  it("does not reject when the registry refuses the kind: the asset is saved either way", async () => {
    const { calls, spy } = await run({ ...authed(), "POST /api/assets": { body: CREATED }, "POST /api/asset-kinds": { status: 409, body: { detail: "A kind with that name already exists" } } }, { registerKind: true });
    await waitFor(() => expect(outcome()).toBe("created 9"));
    expect(count(calls, "POST", "/api/asset-kinds")).toBe(1);
    expect(spy.calls).toEqual([{ kind: "success", text: "Asset created" }]);
    await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(2)); // the failed mutation still refreshes (onSettled)
  });

  it("sends no kind request without assets.kinds, even when the form asked for one, and refreshes instead", async () => {
    const { calls } = await run({ ...authed(["assets.view", "assets.edit"]), "POST /api/assets": { body: CREATED } }, { registerKind: true });
    await waitFor(() => expect(outcome()).toBe("created 9"));
    await waitFor(() => expect(count(calls, "GET", "/api/assets")).toBe(2));
    expect(count(calls, "POST", "/api/asset-kinds")).toBe(0);
  });

  it("also refreshes the keys the caller names: after a refresh, and after a kind was registered", async () => {
    const plain = await run({ ...authed(), "POST /api/assets": { body: CREATED } }, { registerKind: false, also: [keys.billing] });
    await waitFor(() => expect(probeFetches(plain.calls).billing).toBe(2));
    expect(probeFetches(plain.calls).widgetData).toBe(1);
  });

  it("also refreshes the keys the caller names when it registered a kind", async () => {
    const routes = { ...authed(), "POST /api/assets": { body: CREATED }, "POST /api/asset-kinds": { status: 201, body: { id: 3, name: "Pump", icon: "pump", asset_count: 1, starter: false } } };
    const { calls } = await run(routes, { registerKind: true, also: [keys.billing] });
    await waitFor(() => expect(probeFetches(calls).billing).toBe(2));
  });

  it("rejects with the server's sentence when the asset request fails, with no toast and no refresh", async () => {
    const { calls, spy } = await run({ ...authed(), "POST /api/assets": { status: 422, body: { detail: "name is required" } } }, { registerKind: true });
    await waitFor(() => expect(outcome()).toMatch(/^rejected /));
    expect(spy.calls).toEqual([]);
    expect(count(calls, "POST", "/api/asset-kinds")).toBe(0);
    expect(count(calls, "GET", "/api/assets")).toBe(1);
  });
});
