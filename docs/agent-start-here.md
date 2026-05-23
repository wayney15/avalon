# Agent Start Here

This document is the starting point for any new agent working on this project.

## Mission

Build a lightweight mobile-first web application for hosting private games of The Resistance: Avalon using:

- React + Vite + TypeScript
- Cloudflare Workers + Hono + TypeScript
- Durable Objects for realtime room/game coordination
- D1 for persistence

## Authoritative Sources

Read these in order:

1. [v1-spec.md](/mnt/h/avalon/project/docs/v1-spec.md)
   Product scope and the user-facing behavior that v1 must support.
2. [rules.md](/mnt/h/avalon/project/rules.md)
   Game rules source of truth.
3. [rules-gap-review.md](/mnt/h/avalon/project/docs/rules-gap-review.md)
   Implementation decisions that make the raw rules executable in this product.
4. [implementation-handoff.md](/mnt/h/avalon/project/docs/implementation-handoff.md)
   Overall architecture and workstream plan.
5. [implementation-checklist.md](/mnt/h/avalon/project/docs/implementation-checklist.md)
   Concrete execution order and completion gates.

Use these as focused references while implementing:

- [database-handoff.md](/mnt/h/avalon/project/docs/database-handoff.md)
- [auth-handoff.md](/mnt/h/avalon/project/docs/auth-handoff.md)
- [realtime-handoff.md](/mnt/h/avalon/project/docs/realtime-handoff.md)
- [shared-contract-targets.md](/mnt/h/avalon/project/docs/shared-contract-targets.md)
- [api-examples.md](/mnt/h/avalon/project/docs/api-examples.md)

## Fixed Product Decisions

Do not re-decide these unless the user changes them:

- username + password auth
- self-signup allowed
- JWT on subsequent requests
- usernames are globally unique
- display names are separate from usernames
- invite link + room code room entry
- open lobby showing joined users
- real-time multiplayer over WebSockets
- 5 to 10 players
- backend-authoritative game state
- mobile-first UI
- no chat in v1
- no timers in v1
- spectators are allowed
- spectators can see all roles
- spectators may be in the lobby and remain during game if already present
- locked rooms reject all new joins, including spectators
- disconnection pauses the game
- host may force-remove disconnected player and terminate game
- terminated games are stored as `unfinished`
- multiple games can be played in one room history
- host can randomize seats between games
- initial secret information uses press-and-hold reveal
- irreversible actions use explicit confirmation

## Fixed Avalon Interpretation

These decisions close gaps between tabletop rules and the web implementation:

- host selects named special roles only
- backend auto-fills remaining good slots with `loyal-servant`
- backend auto-fills remaining evil slots with `minion`
- `merlin` and `percival` are mandatory in v1 role validation
- host explicitly advances from `night` to `proposal`
- active game roster is immutable once the game starts
- no player substitution mid-game
- if a player disconnects, the game pauses rather than shrinking the voter set
- leader rotation follows seat order
- seat randomization only happens between games
- final role reveal happens only after game termination

## Workspace Map

- [README.md](/mnt/h/avalon/project/README.md)
  High-level stack and workspace overview.
- [apps/web](/mnt/h/avalon/project/apps/web)
  Frontend application scaffold.
- [apps/api](/mnt/h/avalon/project/apps/api)
  Worker API scaffold and Durable Object entrypoint.
- [packages/shared](/mnt/h/avalon/project/packages/shared)
  Shared contract package.

## Current Code Status

Already present:

- monorepo workspace scaffold
- D1 migrations for users, rooms, memberships, games, and replay events
- Worker API auth flow with signup, login, `me`, JWT signing, and auth middleware
- room lifecycle routes for create, join, snapshot, history, replay, and websocket upgrade
- Durable Object room coordinator with:
  - personalized room snapshots
  - player and spectator presence
  - host transfer, kick, seat swap, and seat randomization
  - game start, proposal, team vote, quest vote, assassination, finish, pause/resume, and forced termination
- shared contracts for auth, room, replay, and active game payloads
- dependency installation completed
- workspace typecheck completed
- frontend production build completed

Not implemented yet:

- functional frontend product UI in `apps/web`
- automated runtime/integration coverage for API, Durable Object, and D1 flows
- any additional backend bugfixes discovered during real client integration

## First Safe Implementation Path

Follow this order:

1. verify whether the user wants frontend delivery, backend hardening, or both
2. if frontend work is next, treat the backend contracts in `apps/api/src` and `packages/shared/src` as the starting point and wire the real client flows
3. if backend hardening is next, add runtime or integration coverage before broad refactors
4. reconcile any shared contract drift before exposing more client behavior
5. only revisit core game-state logic when a concrete rules or authorization bug is found

## Non-Negotiable Invariants

- the backend is the source of truth for all state transitions
- clients must never receive hidden data they are not authorized to see
- reconnect binds by authenticated user identity, not client-provided ids
- room code and invite token generation must handle collisions
- locked rooms reject all new joins
- replay/history must filter hidden events by viewer authorization
- spectators are special:
  - they can see all roles
  - they cannot join once the room is locked

## If You Need Concrete Payload Shapes

Use:

- [shared-contract-targets.md](/mnt/h/avalon/project/docs/shared-contract-targets.md)
- [api-examples.md](/mnt/h/avalon/project/docs/api-examples.md)

## If You Need Acceptance Criteria

Use:

- [implementation-checklist.md](/mnt/h/avalon/project/docs/implementation-checklist.md)
- [rules-gap-review.md](/mnt/h/avalon/project/docs/rules-gap-review.md)

## What Not To Add

Do not add these unless the user explicitly requests them:

- chat
- timers
- social graph or friend system
- password reset flow
- admin tooling
- analytics
