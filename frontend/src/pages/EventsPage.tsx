import { PageHeader } from "../components/PageHeader";

/** w32 Task 4a: the place of the System events page (route /events and /events/:id). Task 4b replaces this body with the page itself. */
export function EventsPage() {
  return (
    <section className="admin-page">
      <PageHeader title="System events" />
    </section>
  );
}
