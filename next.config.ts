import type { NextConfig } from "next";

// Static export for Firebase Hosting. Security headers live in
// firebase.json (`hosting.headers`) because `headers()` is unsupported with `output: "export"`.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
