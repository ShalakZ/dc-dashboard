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
        if (!body.needed) throw new Error("the stack already has users; run scripts/e2e.sh for a fresh database");
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
