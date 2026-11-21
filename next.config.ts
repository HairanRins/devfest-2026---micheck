import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Optional local models (docs/adr-local-fallback.md): native/WASM packages
  // loaded at runtime from node_modules, never bundled.
  output: "standalone",
  serverExternalPackages: ["node-llama-cpp", "tesseract.js"],
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
