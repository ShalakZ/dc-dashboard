/** What a person whose role holds no permission for any page lands on (the home route has nowhere to send them). */
export function NoPages() {
  return (
    <section>
      <h1>Your role has no pages yet.</h1>
      <p className="muted">Ask an administrator to give your role access.</p>
    </section>
  );
}
