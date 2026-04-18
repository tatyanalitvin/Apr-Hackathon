/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  // Transpile workspace source packages (we ship TS, not dist).
  transpilePackages: ["@ai-herders/shared"],
  output: "standalone",
};

export default nextConfig;
