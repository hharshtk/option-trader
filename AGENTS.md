<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Server and deployment

- The frontend deploys to Vercel; only the engine runs on the OCI VM, behind Caddy at `https://<public IP>`.
- To set up or move the server, follow [docs/server-setup.md](docs/server-setup.md) step by step. It lists which steps need the person and which change what the internet can reach.
- How the engine works: [docs/engine.md](docs/engine.md). What is planned: [docs/engine-plan.md](docs/engine-plan.md).
- What the Pulse page computes (verdict, attribution, Signal lab, option replay): [docs/pulse.md](docs/pulse.md).
