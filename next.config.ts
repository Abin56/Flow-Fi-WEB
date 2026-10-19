import type { NextConfig } from "next";

/**
 * Conservative security headers. Deliberately NOT included:
 * - Content-Security-Policy: needs end-to-end testing against Firebase Auth,
 *   Firestore long-polling, Cloud Functions and next/font before enabling.
 * - Cross-Origin-Opener-Policy: Google sign-in uses signInWithPopup, which
 *   breaks under `same-origin`.
 */
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
