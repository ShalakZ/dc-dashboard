/** What a display secret looks like (the server makes 43 characters of URL-safe base64; 64 is the most the page accepts). */
const SECRET = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The display link is `/display#<secret>`. main.tsx calls this first, synchronously, before anything is mounted or requested:
 * it reads the fragment, ALWAYS puts the plain `/display` address back (so the secret never stays in the address bar, the history
 * entry or a later copy of the address, whether or not it was a good one), and returns the secret, or null when there was none or
 * it is not 1 to 64 letters, digits, `_` or `-` (a longer one is refused, never cut short: a cut secret is a wrong secret).
 * A fragment never reaches a server, a log or a Referer; the secret travels only in the JSON body of the claim.
 */
export function takeFragment(): string | null {
  const raw = window.location.hash;
  window.history.replaceState(null, "", "/display");
  const secret = raw.replace(/^#/, "").trim();
  return SECRET.test(secret) ? secret : null;
}
