import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Native image libs stay out of the bundle; fonts ship with the server functions.
  serverExternalPackages: ["sharp", "@resvg/resvg-js"],
  outputFileTracingIncludes: {
    "/**": ["./src/lib/render/fonts/**"],
  },
  images: { unoptimized: true },
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
