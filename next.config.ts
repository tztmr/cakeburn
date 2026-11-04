import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  ...(process.env.CAKEBURN_SERVER === "1" ? { output: "standalone" as const } : {}),
};

export default nextConfig;
