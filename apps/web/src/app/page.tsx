import { APP_NAME, BACKEND_URL } from "@/lib/backend";

export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-4xl font-bold">{APP_NAME}</h1>
      <p className="mt-4 text-gray-600">
        Online chat server — Next.js 15 web + Fastify backend + Drizzle + better-auth +
        Socket.IO. Scaffold swap complete (H+2). S1 walking skeleton next.
      </p>
      <ul className="mt-6 list-disc pl-6 text-sm text-gray-700">
        <li>
          <code className="rounded bg-gray-100 px-1">pnpm dev</code> — web + backend in parallel
        </li>
        <li>
          Backend health:{" "}
          <code className="rounded bg-gray-100 px-1">{BACKEND_URL}/health</code>
        </li>
        <li>
          See <code className="rounded bg-gray-100 px-1">docs/BRIEF.md</code> for scope and{" "}
          <code className="rounded bg-gray-100 px-1">docs/specs/</code> for feature specs
        </li>
      </ul>
    </main>
  );
}
