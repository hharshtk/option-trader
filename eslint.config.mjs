import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Code the engine runs under plain Node: no Next.js, no server-only, no @/ path alias.
const PLAIN_NODE = [
  "src/engine/**/*.ts",
  "src/lib/engine/protocol.ts",
  "src/lib/dhan/{api,client,config,errors,instruments,option-contracts,option-scrips,rate-limit,token-store,types}.ts",
  "src/lib/live/feed/{dhan-feed,feed-hub,monitor,packets}.ts",
  "src/lib/{storage,index-constituents}.ts",
  "src/lib/db/duckdb.ts",
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: PLAIN_NODE,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/*"], message: "Plain Node can't resolve @/ paths. Use a relative .ts import." },
            { group: ["next", "next/*", "server-only"], message: "The engine runs without Next.js." },
          ],
        },
      ],
    },
  },
  // Kernel code gets time only from the injected Clock, so replays match live runs exactly.
  {
    files: ["src/engine/kernel/**/*.ts", "src/engine/market/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Use the injected Clock." },
        { object: "performance", property: "now", message: "Use the injected Clock." },
      ],
      "no-restricted-globals": [
        "error",
        ...["setTimeout", "setInterval", "setImmediate", "clearTimeout", "clearInterval"].map((name) => ({
          name,
          message: "Use clock.at() so replays run on virtual time.",
        })),
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
