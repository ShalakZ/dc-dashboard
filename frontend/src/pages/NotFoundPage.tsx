import { Link } from "react-router";
import { PageHeader } from "../components/PageHeader";

/** What an unknown address shows: a page inside the layout, so the nav stays and there is a way back. */
export function NotFoundPage() {
  return (
    <section>
      <PageHeader title="Page not found" />
      <div className="empty">
        <span className="empty-icon" aria-hidden="true">
          <svg className="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /><path d="M8.5 11h5" /></svg>
        </span>
        <p>There is nothing at this address. <Link to="/assets">Back to Assets</Link></p>
      </div>
    </section>
  );
}
