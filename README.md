# Avalon Web

Cloudflare-first web application for hosting private games of The Resistance: Avalon.

## Stack

- Frontend: React + Vite + TypeScript
- Backend: Cloudflare Workers + Hono + TypeScript
- Realtime room/game state: Durable Objects
- Persistence: D1
- Auth: username/password with JWT

## Workspace

- `apps/web` - client application
- `apps/api` - Worker API and Durable Object entrypoint
- `packages/shared` - shared domain types and event contracts
- `docs` - product and architecture notes

## Agent Guide

- Start here: [`docs/agent-start-here.md`](./docs/agent-start-here.md)

## Next Steps

- Install dependencies
- Create the D1 schema and migrations
- Implement auth endpoints and JWT session flow
- Implement room lifecycle and lobby WebSocket events
- Implement authoritative Avalon game state machine
