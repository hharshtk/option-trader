import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // Native module: load it with Node's require instead of bundling it.
  serverExternalPackages: ["@duckdb/node-api"],
  // DuckDB's duckdb.node loads libduckdb.so through the system linker, which file tracing can't
  // see, so serverless deploys would leave it out. Add each route that uses DuckDB here.
  outputFileTracingIncludes: {
    "/settings": ["./node_modules/@duckdb/node-bindings-linux-x64/**/*"],
    "/instruments": ["./node_modules/@duckdb/node-bindings-linux-x64/**/*"],
  },
  // data/ holds runtime files (src/lib/storage.ts), never code the server needs to ship.
  outputFileTracingExcludes: {
    "/*": ["./data/**/*"],
  },
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
