# Avalon Hosting Guide

This repository is a monorepo for a Cloudflare-first Avalon app:

- `apps/web`: React + Vite frontend
- `apps/api`: Cloudflare Worker API built with Hono
- `packages/shared`: shared types/contracts
- `apps/api` also depends on:
  - Cloudflare D1 for persistence
  - Cloudflare Durable Objects for live room state and WebSocket coordination

The cleanest production setup is:

1. Deploy `apps/api` as a Cloudflare Worker.
2. Create a D1 database and bind it to the Worker as `DB`.
3. Let Wrangler provision the Durable Object from `wrangler.toml`.
4. Deploy `apps/web` as a static site on Cloudflare Pages.
5. Set `VITE_API_BASE_URL` in the frontend to the Worker URL or your API custom domain.

## Prerequisites

- Node.js 20+
- npm
- A Cloudflare account
- Wrangler CLI available through the repo dependencies

Install dependencies from the repo root:

```bash
npm install
```

## Application Requirements

The deployed app needs these runtime pieces:

- `DB`: D1 database binding
- `ROOMS`: Durable Object namespace binding
- `JWT_ISSUER`: string used when signing auth tokens
- `JWT_SECRET`: secret used when signing auth tokens

The frontend needs:

- `VITE_API_BASE_URL`: public base URL for the API, for example `https://api.example.com`

## Deploy The API

### 1. Authenticate Wrangler

```bash
npx wrangler login
```

### 2. Create the production D1 database

```bash
npx wrangler d1 create avalon-db
```

Wrangler will print a `database_id`. Copy that ID into [`apps/api/wrangler.toml`](/mnt/h/avalon/project/apps/api/wrangler.toml) and replace:

```toml
database_id = "replace-me"
```

with the real database ID.

### 3. Configure Worker variables

[`apps/api/wrangler.toml`](/mnt/h/avalon/project/apps/api/wrangler.toml) already defines:

```toml
name = "avalon-api"
main = "src/index.ts"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "RoomCoordinator"

[[d1_databases]]
binding = "DB"
database_name = "avalon-db"

[vars]
JWT_ISSUER = "avalon-web"
JWT_SECRET = "replace-me"
```

For production, treat `JWT_SECRET` as a secret, not a committed config value. Set it with Wrangler:

```bash
npx wrangler secret put JWT_SECRET --config apps/api/wrangler.toml
```

You can leave `JWT_ISSUER` in `wrangler.toml` or change it to your production issuer string.

### 4. Run the D1 migrations against production

Apply both SQL migration files:

```bash
npx wrangler d1 execute DB --remote --config apps/api/wrangler.toml --file apps/api/migrations/0001_initial.sql
npx wrangler d1 execute DB --remote --config apps/api/wrangler.toml --file apps/api/migrations/0002_indexes.sql
```

### 5. Deploy the Worker

```bash
npx wrangler deploy --config apps/api/wrangler.toml
```

After deploy, note the public Worker URL, for example:

```text
https://avalon-api.<your-subdomain>.workers.dev
```
```
https://avalon-api.wayney411.workers.dev
```
If you want a cleaner production URL, attach a custom domain to the Worker and use that instead.

## Deploy The Frontend

The frontend builds to static assets and can be hosted on Cloudflare Pages or any static host. Cloudflare Pages is the simplest match for this repo.

### Option A: Cloudflare Pages

Set these build settings for the repo:

- Build command: `npm run build --workspace @avalon/web`
- Build output directory: `apps/web/dist`
- Root directory: repo root

Set this environment variable in Pages:

```bash
VITE_API_BASE_URL=https://avalon-api.<your-subdomain>.workers.dev
```

If your API uses a custom domain, use that URL instead.

### Option B: Cloudflare Workers static assets via Wrangler

If you want to use `wrangler deploy` for the frontend instead of Pages, this repo now includes [`apps/web/wrangler.jsonc`](/mnt/h/avalon/avalon/apps/web/wrangler.jsonc).

That worker serves the built SPA and proxies same-origin `/api/*` requests to the API Worker configured by `API_ORIGIN` in `apps/web/wrangler.jsonc`.

Build and deploy with:

```bash
npm run deploy:web
```

That config tells Wrangler to publish the built `apps/web/dist` directory, uses SPA fallback routing so deep links like `/rooms/invite/...` resolve to `index.html`, and forwards `/api/*` and room WebSocket traffic to the configured API origin.

### Option C: Manual static deploy

Build the frontend locally:

```bash
VITE_API_BASE_URL=https://avalon-api.<your-subdomain>.workers.dev npm run build --workspace @avalon/web
```

Then deploy the generated `apps/web/dist` directory to your static hosting provider.

## Domain And Routing Notes

The frontend calls the API over HTTP and opens room sockets at:

- REST: `/api/...`
- WebSocket: `/api/rooms/:roomId/ws`

The frontend derives the WebSocket URL from `VITE_API_BASE_URL`, so:

- `https://api.example.com` becomes `wss://api.example.com`
- `http://localhost:8787` becomes `ws://localhost:8787`

Because the API enables permissive CORS right now, the frontend can live on a different origin. If you later lock down CORS, update the API before moving the frontend to a different domain.

## Recommended Production Shape

Use two public domains:

- `https://app.example.com` for the frontend
- `https://api.example.com` for the Worker API

Then set:

```bash
VITE_API_BASE_URL=https://api.example.com
```

This keeps the deployment simple and makes WebSocket routing predictable.

## Local Verification Before Deploying

From the repo root:

1. Create `apps/api/.dev.vars`:

```bash
JWT_SECRET=local-dev-secret
JWT_ISSUER=avalon-web
```

2. Run local migrations:

```bash
npm run db:migrate:local
```

3. Start the API:

```bash
npm run dev:api
```

4. Start the frontend in a second terminal:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev:web
```

5. Build everything once before production deploy:

```bash
npm run build
npm run test
```

## First Production Smoke Test

After both deployments are live:

1. Open the frontend.
2. Create a user account.
3. Create a room.
4. Open the invite link in a second browser session.
5. Join the same room and confirm:
   - REST requests succeed
   - room updates stream over WebSocket
   - room creation and join data persist after refresh

## Current Repo-Specific Notes

- The Worker config currently contains placeholders in [`apps/api/wrangler.toml`](/mnt/h/avalon/project/apps/api/wrangler.toml); those must be replaced before production deploy.
- For Pages or any other plain static host, set `VITE_API_BASE_URL` explicitly.
- For `wrangler deploy` using [`apps/web/wrangler.jsonc`](/mnt/h/avalon/avalon/apps/web/wrangler.jsonc), same-origin `/api` routing is handled by the web worker proxy via `API_ORIGIN`.
- Durable Objects require deployment through Cloudflare Workers. If you move the API off Cloudflare, the realtime room system will need to be redesigned.


## Hosting locally
npm install

Create apps/api/.dev.vars with:

JWT_SECRET=local-dev-secret
JWT_ISSUER=avalon-web

Then run the local database migrations:

npm run db:migrate:local

Start the API in one terminal:

npm run dev:api

Start the web app in a second terminal:

VITE_API_BASE_URL=http://127.0.0.1:8787 npm run dev:web

## tailing logs
npx wrangler tail --config wrangler.toml
