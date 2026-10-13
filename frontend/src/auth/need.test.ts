import type { PermissionId } from "../lib/permissions";
import { meets } from "./need";

/** `can` for a person who holds exactly `held`. */
const holding = (...held: PermissionId[]) => (id: PermissionId) => held.includes(id);

describe("meets", () => {
  it("a single permission is met by holding it, and by nothing else", () => {
    expect(meets("assets.view", holding("assets.view"))).toBe(true);
    expect(meets("assets.view", holding("billing.view"))).toBe(false);
    expect(meets("assets.view", holding())).toBe(false);
  });

  it("a list means ALL OF: one missing id fails it", () => {
    const need = ["tariffs.view", "assets.view"] as const;
    expect(meets(need, holding("tariffs.view", "assets.view"))).toBe(true);
    expect(meets(need, holding("tariffs.view"))).toBe(false);
    expect(meets(need, holding("assets.view"))).toBe(false);
    expect(meets([], holding())).toBe(true); // nothing listed, nothing missing
  });

  it("{ any } means ANY OF: each id alone is enough, none is not", () => {
    const need = { any: ["users.view", "roles.manage"] } as const;
    expect(meets(need, holding("users.view"))).toBe(true);
    expect(meets(need, holding("roles.manage"))).toBe(true);
    expect(meets(need, holding("users.view", "roles.manage"))).toBe(true);
    expect(meets(need, holding("users.edit", "assets.view"))).toBe(false); // other permissions of the same area do not open it
    expect(meets(need, holding())).toBe(false);
  });

  it("{ any: [] } is never met: there is nothing that would open it", () => {
    expect(meets({ any: [] }, holding())).toBe(false);
    expect(meets({ any: [] }, holding("assets.view", "users.view"))).toBe(false);
  });

  it("nothing needed is always met", () => {
    expect(meets(undefined, holding())).toBe(true);
  });
});
