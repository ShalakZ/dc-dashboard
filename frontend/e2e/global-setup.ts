import type { FullConfig } from "@playwright/test";

export default async function globalSetup(config: FullConfig) {
  const base = (config.projects[0].use.baseURL as string).replace(/\/$/, "");
  const deadline = Date.now() + 120_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/setup`);
      if (res.ok) {
        const body = (await res.json()) as { needed: boolean };
        if (!body.needed) {
          throw new Error(
            "the stack already has users, so this is not a fresh end-to-end database. Do NOT run " +
              "`docker compose down -v` on the normal project: it deletes the dcdash_dbdata volume. Use the isolated project " +
              "(stop the normal stack with `docker compose --profile dev stop`, then `docker compose -p dcdash_e2e --profile dev " +
              "down -v --remove-orphans` and `docker compose -p dcdash_e2e --profile dev up -d --build`, then `npm run e2e`), " +
              "or run scripts/e2e.sh, which does that in the dcdash_e2e project; see the README, section End-to-end test.",
          );
        }
        return;
      }
      last = `HTTP ${res.status}`;
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("the stack already")) throw e;
      last = String(e);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`stack not ready at ${base} after 120 s (last: ${last})`);
}
