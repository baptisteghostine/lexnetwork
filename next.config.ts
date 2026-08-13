import type { NextConfig } from "next";

// Server Actions abort when the `origin` header's host doesn't match the
// (forwarded) host — a CSRF guard that also trips in proxied dev environments:
// Codespaces/Gitpod serve the app from their own domain while the preview can
// still report a localhost origin, so the two never agree.
//
// Development allows those proxy origins. Production stays strict unless the
// deployer names their reverse-proxy host in ROLO_ALLOWED_ORIGINS
// (comma-separated `host[:port]`; `*.example.com` wildcards match subdomains).
const configuredOrigins = (process.env.ROLO_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const devProxyOrigins =
  process.env.NODE_ENV === "development"
    ? [
        "localhost:3000",
        "127.0.0.1:3000",
        "*.app.github.dev", // GitHub Codespaces forwarded ports
        "*.githubpreview.dev",
        "*.gitpod.io",
        "*.gitpod.dev",
      ]
    : [];

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      allowedOrigins: [...devProxyOrigins, ...configuredOrigins],
    },
  },
};

export default nextConfig;
