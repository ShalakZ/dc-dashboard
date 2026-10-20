/**
 * What the display screen is given instead of the link's secret. The claim loop reads the secret from it for the claim (and for every
 * retry of a claim that had no answer) and calls `release()` itself at the first definite answer; from then on the string exists
 * nowhere in the page. The page's script can still be reached by markup the server sends (w29 shows user-authored text here), and
 * `HttpOnly` protects the cookie only, so the reusable link must not outlive its one use.
 */
export interface SecretHandle {
  /** The secret until it is released, then null. */
  secret(): string | null;
  /** Drops the secret for good. Safe to call twice. */
  release(): void;
}

/** A handle on the secret `takeFragment` found, or null when there was none (a screen opened without its link: the cookie may be there). */
export function holdSecret(secret: string | null): SecretHandle | null {
  if (secret === null) return null;
  let held: string | null = secret;
  return {
    secret: () => held,
    release: () => {
      held = null;
    },
  };
}
