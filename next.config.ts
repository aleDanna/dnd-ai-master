import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: '/sessions', destination: '/campaigns', permanent: true },
      { source: '/sessions/new', destination: '/campaigns/new', permanent: true },
    ];
  },
};

export default nextConfig;
