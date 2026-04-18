export default function Home() {
  return (
    <main className="mx-auto max-w-2xl p-10">
      <h1 className="text-4xl font-bold">Hackathon Starter</h1>
      <p className="mt-4 text-gray-600">
        Next.js 15 + TS + Tailwind + shadcn/ui + Anthropic SDK. Pre-wired with Claude Code
        agents, skills, and hooks. Replace this page on day&nbsp;0.
      </p>
      <ul className="mt-6 list-disc pl-6 text-sm text-gray-700">
        <li>
          <code className="rounded bg-gray-100 px-1">pnpm dev</code> — start the app
        </li>
        <li>
          <code className="rounded bg-gray-100 px-1">POST /api/chat</code> — streaming Claude
          endpoint
        </li>
        <li>Read <code className="rounded bg-gray-100 px-1">docs/PLAYBOOK.md</code> before you start</li>
      </ul>
    </main>
  );
}
