import { screen } from "@testing-library/react";
import { useAuth } from "../auth/AuthProvider";

/**
 * Renders a marker once the account is known. A control that needs a permission is absent until /api/me has answered, so a test that
 * expects one to stay ABSENT renders this next to the page and waits for `accountKnown()` first (otherwise it checks too early).
 */
export function SignedIn() {
  const { user } = useAuth();
  return user ? <span data-testid="signed-in">{user.username}</span> : null;
}

export const accountKnown = () => screen.findByTestId("signed-in");
