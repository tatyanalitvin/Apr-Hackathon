// Admin route layout — wraps /admin and /admin/federation with the shared
// app Header so those pages stop rendering header-less. The admin pages
// themselves handle 401/403 gating via the backend metrics endpoint, so we
// don't wrap in RequireSession here (that would double-gate and flash).
import { Header } from "@/components/chat/Header";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col h-dvh">
      <Header />
      {children}
    </div>
  );
}
