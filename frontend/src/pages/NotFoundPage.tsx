import { Link } from "react-router";

/** What an unknown address shows: a page inside the layout, so the nav stays and there is a way back. */
export function NotFoundPage() {
  return (
    <section>
      <h1>Page not found</h1>
      <p className="muted">There is nothing at this address. <Link to="/assets">Back to Assets</Link></p>
    </section>
  );
}
