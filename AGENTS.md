<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Constitution

- Read [docs/constitution.md](docs/constitution.md) before proposing or starting a feature. It says what this app is for (predicting NIFTY from live data with Decision APIs, and trading only on predictions that have proven themselves) and what it won't become (a backtester, a strategy builder, a collection of settings). Check every proposal against its "Deciding what to build" list. If a request conflicts with it, say so and let the owner decide. Only the owner amends it.
- What is built, being built and next: [docs/roadmap.md](docs/roadmap.md). Update it in the same change whenever a feature ships or a plan changes.
- How predictions are made and graded (the prediction scoreboard): [docs/predictions.md](docs/predictions.md).

## Server and deployment

- The frontend deploys to Vercel; only the engine runs on the OCI VM, behind Caddy at `https://<public IP>`.
- To set up or move the server, follow [docs/server-setup.md](docs/server-setup.md) step by step. It lists which steps need the person and which change what the internet can reach.
- How the engine works: [docs/engine.md](docs/engine.md). What is planned: [docs/engine-plan.md](docs/engine-plan.md).
- What the Pulse page computes (verdict, attribution, Signal lab, option replay): [docs/pulse.md](docs/pulse.md).
- How the engine trades (paper trading, the decision API gate, charges, Parquet tables on S3): [docs/trading.md](docs/trading.md). Live orders exist only as the one-lot pilot the owner allowed on 22 Nov 2026 ([constitution §6](docs/constitution.md#6-going-live), [trading.md](docs/trading.md#live-pilot)); nothing else may place an order with Dhan until that document's go-live steps are met, and the pilot's limits are never loosened.
- What data there is for research (minute history, recordings) and what to watch out for: [docs/research.md](docs/research.md).
- Storage rule: anything that needs a database is a Parquet file in the file store (S3), read and written with DuckDB through [src/lib/db/parquet-store.ts](src/lib/db/parquet-store.ts). No SQLite, no DuckDB database file.
