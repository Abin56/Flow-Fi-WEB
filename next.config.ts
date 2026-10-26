import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

// Static export for Firebase Hosting. Security headers live in
// firebase.json (`hosting.headers`) because `headers()` is unsupported with `output: "export"`.
//
// `next dev` can't serve real ids under `output: "export"` (only the "_" placeholder from
// generateStaticParams), so dev drops the export and mirrors the firebase.json rewrite instead.
const nextConfig: NextConfig = {
  ...(isDev ? {} : { output: "export" as const }),
  trailingSlash: true,
  images: { unoptimized: true },
  ...(isDev
    ? {
        async rewrites() {
          return [{ source: "/statement-review/:documentId((?!_$)[^/]+)", destination: "/statement-review/_" }];
        },
      }
    : {}),
};

export default nextConfig;
