export default function FederationAdminPage() {
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="mb-4 text-2xl font-semibold">Federation</h1>
      <p className="mb-2">No federation peers.</p>
      <p className="mb-2">
        Configure <code>XMPP_DOMAIN</code> to enable.
      </p>
      <p>
        See <code>docs/FEDERATION.md</code>.
      </p>
    </main>
  );
}
