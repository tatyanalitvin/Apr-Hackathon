import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_APP_NAME ?? "AI Herders Jam",
  description: "Online chat server — AI Herders Jam hackathon 2026",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-gray-900 antialiased">{children}</body>
    </html>
  );
}
