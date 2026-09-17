import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Provider secrets are only ever read on the server. Nothing here is exposed
  // to the client bundle except values explicitly prefixed with NEXT_PUBLIC_.
  serverExternalPackages: [],
};

export default nextConfig;
