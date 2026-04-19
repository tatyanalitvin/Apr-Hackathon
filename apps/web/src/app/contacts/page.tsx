// REQ-050 / REQ-057..059 / REQ-073..074 / REQ-136 — /contacts route. Session-
// gated wrapper around the client container.

import { RequireSession } from "@/components/chat/RequireSession";
import { ContactsClient } from "./ContactsClient";

export default function ContactsPage() {
  return (
    <RequireSession>
      <ContactsClient />
    </RequireSession>
  );
}
