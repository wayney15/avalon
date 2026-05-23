# Implementation Handoff

This document is for the next agent.

Important: this is no longer a greenfield backend handoff. The core backend work described below is largely implemented in the workspace. Use this document as architecture context, but use the status section immediately below to decide what to do next.

## Status As Of 2026-05-22

Completed in the current workspace:

- D1 migrations exist in `apps/api/migrations/0001_initial.sql` and `0002_indexes.sql`
- shared contracts in `packages/shared/src/*` are expanded well beyond the initial scaffold
- auth is implemented:
  - `POST /api/auth/signup`
  - `POST /api/auth/login`
  - `GET /api/auth/me`
  - JWT auth middleware for protected routes
- room lifecycle HTTP routes are implemented:
  - `POST /api/rooms`
  - `POST /api/rooms/join`
  - `GET /api/rooms/:roomId`
- room history and replay routes are implemented:
  - `GET /api/rooms/:roomId/history`
  - `GET /api/games/:gameId`
- room WebSocket upgrade is implemented at `GET /api/rooms/:roomId/ws`
- the Durable Object coordinator implements:
  - live room snapshots
  - player/spectator presence
  - host transfer
  - seat swap and seat randomization
  - player kick
  - game start
  - proposal flow
  - team vote flow
  - quest vote flow
  - assassination flow
  - disconnect pause/resume
  - force-remove disconnected player and unfinished termination
- replay/history visibility was re-checked:
  - room history now uses historical access checks
  - spectators can see replay-hidden information as intended
- workspace verification currently passes:
  - `npm run typecheck`
  - `npm run build`

Still left for the next agent:

- build the actual product UI in `apps/web`; it is still a static landing shell, not a working Avalon client
- run runtime validation against Worker/Durable Object/D1 behavior; there are no automated integration tests in the repo
- close contract/implementation drift:
  - `room.end-game` exists in `packages/shared/src/room.ts` but is not handled in `apps/api/src/room-coordinator.ts`
- audit event persistence and payloads against docs before adding new client code, because the implementation has moved faster than the written handoff
- decide whether to add tests before more feature work; current verification is compile/build only

Recommended next focus:

1. keep backend changes narrow unless a real bug is found
2. either implement the actual frontend flows in `apps/web`, or add runtime/integration coverage for the backend before UI work
3. if touching websocket contracts, reconcile `packages/shared/src/room.ts`, `docs/api-examples.md`, and `apps/api/src/room-coordinator.ts` together
Original scope covered here:

1. D1 schema and migrations
2. Auth endpoints and JWT issuance
3. Room Durable Object protocol and the first authoritative lobby/game state machine

## Review Findings

These points were underspecified in the original handoff and should be treated as required implementation decisions for the next agent:

- Room code and invite token generation must handle collisions with retry logic, not optimistic single-write assumptions.
- Host transfer rules need a clear fallback when the host disconnects:
  - recommended v1 behavior: host remains host while disconnected
  - if the host is force-removed during a paused game, transfer host before terminating or immediately after termination using deterministic seat order
- Reconnect must bind by authenticated user identity, not by client-provided room presence identifiers.
- Replay endpoints must filter hidden-role events by viewer authorization even though spectators are allowed to see all roles.
- Join rules during an active locked game should reject both new players and new spectators, because the room is defined as non-joinable while locked.
- Room membership cleanup needs to be explicit:
  - kicked players should be removed from current room membership tables
  - spectators who leave should be removed from live room presence
- Username normalization must be stable and documented so signup and login use identical lookup rules.
- The first agent implementing auth should decide whether display names must be unique within a room at runtime.
  - recommended v1 behavior: allow duplicates, rely on username-backed identity internally

## Constraints

- Stack is fixed:
  - Frontend: React + Vite + TypeScript
  - Backend: Cloudflare Workers + Hono + TypeScript
  - Realtime coordination: Durable Objects
  - Persistence: D1
- Game rules source of truth: `rules.md`
- Product scope source of truth: `memory.md` and `docs/v1-spec.md`
- Backend is authoritative for all hidden game state
- The client must never receive unauthorized role information
- Locked room rule applies to all joins, including spectators

## 1. D1 Schema And Migrations

### Goal

Add the first migration set for user accounts, rooms, room participation, game records, and replayable event logs.

### Files To Create

- `apps/api/migrations/0001_initial.sql`
- `apps/api/migrations/0002_indexes.sql`
- Optional:
  - `apps/api/src/db.ts`
  - `apps/api/src/repositories/*`

### Schema Plan

#### `users`

Purpose:
- login identity
- display identity

Columns:
- `id TEXT PRIMARY KEY`
- `username TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`
- `password_hash TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Notes:
- usernames are globally unique
- display names are not login identifiers
- preserve room/game history even if display name later changes

#### `rooms`

Purpose:
- durable room record independent of the live Durable Object instance

Columns:
- `id TEXT PRIMARY KEY`
- `code TEXT NOT NULL UNIQUE`
- `invite_token TEXT NOT NULL UNIQUE`
- `name TEXT NOT NULL`
- `host_user_id TEXT NOT NULL`
- `status TEXT NOT NULL`
  - expected values: `open`, `locked`, `archived`
- `active_game_id TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Notes:
- `locked` means active game in progress and no new joiners
- `active_game_id` is null when the lobby is idle

#### `room_members`

Purpose:
- current non-spectator membership for a room
- allows room continuity across multiple games

Columns:
- `room_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `seat_index INTEGER`
- `joined_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `is_host INTEGER NOT NULL`
- composite primary key: `(room_id, user_id)`

Notes:
- this table models the current room cohort, not historical participation
- `seat_index` can be null before seating is assigned

#### `room_spectators`

Purpose:
- current spectator presence for room UI hydration

Columns:
- `room_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `joined_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- composite primary key: `(room_id, user_id)`

Notes:
- if you want to simplify, this can be folded into a generic room presence table
- separate tables are acceptable for clarity in v1

#### `games`

Purpose:
- persistent record of each match played inside a room

Columns:
- `id TEXT PRIMARY KEY`
- `room_id TEXT NOT NULL`
- `status TEXT NOT NULL`
  - expected values: `in_progress`, `finished`, `unfinished`
- `player_count INTEGER NOT NULL`
- `host_user_id TEXT NOT NULL`
- `started_at TEXT NOT NULL`
- `ended_at TEXT`
- `ended_reason TEXT`
  - examples: `good_win`, `evil_win`, `assassination`, `five_rejections`, `forced_termination`
- `winner TEXT`
  - expected values: `good`, `evil`, null
- `mission_wins_good INTEGER NOT NULL DEFAULT 0`
- `mission_wins_evil INTEGER NOT NULL DEFAULT 0`

Notes:
- `unfinished` is required for host-terminated disconnected games
- store top-level summary here; detailed history belongs in event tables

#### `game_players`

Purpose:
- immutable roster snapshot for one game

Columns:
- `game_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `display_name_snapshot TEXT NOT NULL`
- `seat_index INTEGER NOT NULL`
- `role TEXT NOT NULL`
- `team TEXT NOT NULL`
- `is_host INTEGER NOT NULL`
- `final_outcome TEXT NOT NULL`
  - examples: `good_win`, `evil_win`, `unfinished`
- composite primary key: `(game_id, user_id)`

Notes:
- snapshot display name and seat because both can change later
- this table supports post-game review without querying live room state

#### `game_events`

Purpose:
- replayable append-only event log

Columns:
- `id TEXT PRIMARY KEY`
- `game_id TEXT NOT NULL`
- `sequence_no INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `actor_user_id TEXT`
- `visible_to TEXT NOT NULL`
  - expected values: `all`, `host`, `evil`, `good`, `self`, `spectators`, `system`
- `subject_user_id TEXT`
- `payload_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Constraints:
- unique `(game_id, sequence_no)`

Notes:
- `visible_to` is for replay filtering and audit tooling
- `payload_json` should be structured and stable enough to rebuild timeline UI

### Event Types To Persist

At minimum:
- `game.created`
- `game.started`
- `roles.assigned`
- `leader.assigned`
- `team.proposed`
- `team.vote.submitted`
- `team.vote.revealed`
- `quest.vote.submitted`
- `quest.result.revealed`
- `score.updated`
- `assassination.started`
- `assassination.resolved`
- `game.finished`
- `game.terminated`
- `player.disconnected`
- `player.reconnected`
- `host.force_removed_disconnected_player`

Important:
- do not persist raw hidden information in events that are intended for `all`
- if hidden information is logged, mark visibility correctly and filter on read

### Indexes

Add at least:
- `users(username)`
- `rooms(code)`
- `rooms(invite_token)`
- `rooms(host_user_id)`
- `games(room_id, started_at DESC)`
- `game_events(game_id, sequence_no)`
- `room_members(room_id, seat_index)`

### Acceptance Checks

- a user can be created with unique username enforcement
- a room can be created with unique room code and invite token
- a game can persist its immutable player roster
- a game timeline can be reconstructed by ordering `game_events.sequence_no`
- an unfinished terminated game is queryable in history
- kicked or removed users no longer appear in current room membership queries

## 2. Auth Endpoints And JWT Issuance

### Goal

Implement self-signup and login with password hashing and JWT-bearing authenticated requests.

### Files To Add Or Update

- `apps/api/src/index.ts`
- `apps/api/src/auth.ts`
- `apps/api/src/jwt.ts`
- `apps/api/src/passwords.ts`
- `apps/api/src/middleware/authenticate.ts`
- `packages/shared/src/auth.ts`

### HTTP Endpoints

#### `POST /api/auth/signup`

Request body:
- `username`
- `displayName`
- `password`

Validation:
- username required
- username normalized before uniqueness check
- reject usernames outside chosen allowed character policy
- display name required
- password must satisfy a minimum policy
  - pragmatic baseline: minimum length only for v1

Behavior:
- create user row
- hash password before persistence
- return JWT session plus user object

Suggested success response:
- `201 Created`
- body:
  - `token`
  - `user`

Error cases:
- `409` username taken
- `400` validation failure

Normalization recommendation:
- lowercase and trim username before persistence and lookup
- preserve original display name casing separately

#### `POST /api/auth/login`

Request body:
- `username`
- `password`

Behavior:
- look up user by normalized username
- verify password hash
- issue JWT

Suggested success response:
- `200 OK`
- body:
  - `token`
  - `user`

Error cases:
- `401` invalid credentials
- `400` malformed request

#### `GET /api/auth/me`

Purpose:
- lightweight session validation and profile hydration

Behavior:
- require bearer token
- decode and validate JWT
- return current user profile

Suggested success response:
- `200 OK`
- body:
  - `user`

### JWT Plan

Recommended claims:
- `sub`: user id
- `iss`: `JWT_ISSUER`
- `iat`
- `exp`
- optional:
  - `username`
  - `displayName`

Token transport:
- bearer token in `Authorization` header

Recommended TTL:
- simple v1 choice: 7 days

Important:
- keep JWT signing server-side only
- choose one signing strategy and keep it narrow
- for Workers, use Web Crypto rather than pulling in a large auth framework

### Password Hashing

Recommended:
- use a password hashing library that works in Workers
- if the agent chooses a Node-only library, that is a mistake for this stack

Requirements:
- never store plain text password
- constant-time verification path through the library

### Route Protection

Protected immediately:
- `POST /api/rooms`
- room join endpoints
- room action endpoints
- all replay/history endpoints
- WebSocket upgrade path for live room/game connection

Additional auth edge case:
- if a JWT is valid but the user row no longer exists, treat the session as unauthorized

### Shared Contract Additions

Add to `packages/shared/src/auth.ts`:
- `AuthMeResponse`
- `AuthErrorResponse`
- `AuthenticatedUserClaims`

### Acceptance Checks

- signup creates user and returns JWT
- login returns JWT for valid credentials
- login rejects bad password
- duplicate username fails cleanly
- protected route rejects missing or invalid JWT
- `GET /api/auth/me` returns the authenticated user

## 3. Room Durable Object Protocol And First State Machine

### Goal

Implement the room Durable Object as the authoritative coordinator for lobby presence, room membership, player seating, game lifecycle, disconnection pauses, and the first complete Avalon state machine.

### Files To Add Or Update

- `apps/api/src/index.ts`
- `apps/api/src/room-coordinator.ts`
- `apps/api/src/room-state.ts`
- `apps/api/src/room-events.ts`
- `apps/api/src/game-rules.ts`
- `packages/shared/src/room.ts`
- `packages/shared/src/game.ts`

### DO Responsibility Split

The Durable Object should own:
- current lobby presence
- current seating
- host identity
- room lock state
- active game state
- pause/resume state on disconnect
- outbound room/game event fanout

D1 should own:
- durable user records
- room records
- completed and unfinished game history
- replayable event log

Rule:
- if the state is needed for immediate synchronization, it belongs in the DO
- if the state is needed after the process dies, it must be persisted to D1

### Live Room Model

Recommended in-memory state:
- room metadata
  - `roomId`
  - `roomCode`
  - `hostUserId`
  - `status`
- presence maps
  - players by user id
  - spectators by user id
  - sockets by connection id
- seating
  - ordered player seat array
- active game
  - nullable when lobby only

### Room HTTP Surface

Recommended Worker routes:

- `POST /api/rooms`
  - create room record
  - create DO id
  - bootstrap DO state
- `POST /api/rooms/join`
  - join by room code or invite token
  - reject if room locked
- `POST /api/rooms/:roomId/spectate`
  - optional if join endpoint already supports `asSpectator`
- `GET /api/rooms/:roomId`
  - initial hydrated room snapshot
- `GET /api/rooms/:roomId/history`
  - room-visible past games
- `GET /api/games/:gameId`
  - game summary plus replay payload
- `GET /api/rooms/:roomId/ws`
  - WebSocket upgrade into live room channel

Join policy:
- while room status is `locked`, reject all joins including spectators

### WebSocket Event Contract

The current shared `RoomEvent` union is too thin. Expand it before implementation.

#### Client To Server Events

Minimum set:
- `room.connect`
- `room.leave`
- `room.join-player`
- `room.join-spectator`
- `room.seat-swap`
- `room.randomize-seats`
- `room.transfer-host`
- `room.kick-player`
- `room.start-game`
- `room.reveal-disconnected`
- `game.advance-to-proposal`
- `game.propose-team`
- `game.submit-team-vote`
- `game.submit-quest-vote`
- `game.submit-assassination`
- `game.request-role-reveal`

#### Server To Client Events

Minimum set:
- `room.snapshot`
- `room.presence.updated`
- `room.host.updated`
- `room.seating.updated`
- `room.locked`
- `room.unlocked`
- `game.phase.changed`
- `game.team.proposed`
- `game.team.vote.revealed`
- `game.quest.result.revealed`
- `game.paused`
- `game.resumed`
- `game.assassination.started`
- `game.finished`
- `game.terminated`
- `history.game.available`
- `error`

### Room Snapshot Shape

Add a single hydrate event that the client can trust after socket connect.

Recommended contents:
- room metadata
- current host
- player list
- spectator list
- seat order
- whether room is locked
- active game summary
- current phase
- current viewer-specific secret state

Important:
- snapshot must be personalized per user
- never include full role map for unauthorized players
- spectators are allowed to see all roles based on current product decision

### Game State Machine

Implement these phases:
- `lobby`
- `night`
- `proposal`
- `team-vote`
- `quest-vote`
- `assassination`
- `finished`
- `unfinished`

#### Setup

On `room.start-game`:
- validate player count 5 to 10
- validate host initiated the action
- validate current room is not locked
- validate selected role pool is compatible with player count and `rules.md`
- assign roles randomly
- compute initial private visibility maps
- lock room
- create `games` row
- create `game_players` rows
- persist `game.started` event
- enter `night`

#### Night

Behavior:
- each player can perform press-and-hold reveal client-side using their personalized secret payload
- after reveal UX is complete, host advances or the server advances immediately depending on chosen UX implementation
- transition to `proposal`

#### Proposal

State:
- current round
- current attempt
- current leader
- required mission size

Rules:
- enforce mission team size from `rules.md`
- only current leader can propose
- persist proposal event
- transition to `team-vote`

#### Team Vote

Rules:
- only active players vote
- hold votes privately until everyone submitted
- reveal simultaneously
- if approve count is greater than reject count:
  - reset rejection tracker
  - transition to `quest-vote`
- otherwise:
  - increment rejection tracker
  - if tracker reaches 5:
    - finish game as evil win
  - else:
    - rotate leader
    - return to `proposal`

#### Quest Vote

Rules:
- only approved quest team members vote
- good players may only submit `success`
- evil players may submit `success` or `fail`
- when all votes received:
  - shuffle result representation before reveal
  - compute mission result
  - apply special two-fail Mission 4 rule for 7+ players
  - persist result and score
- if evil reaches 3 failed missions:
  - finish as evil win
- if good reaches 3 successful missions:
  - transition to `assassination`
- otherwise:
  - advance round
  - rotate leader
  - return to `proposal`

#### Assassination

Rules:
- only assassin can act
- only one target allowed
- require explicit confirmation semantics on client side
- if target is Merlin:
  - finish as evil win
- else:
  - finish as good win

#### Finished

On finish:
- persist final game summary
- persist final role reveal event
- unlock room
- clear `active_game_id`
- allow host to randomize seats and start next game

#### Unfinished

On forced termination after disconnect:
- host can remove disconnected player
- game status becomes `unfinished`
- persist `game.terminated`
- persist terminated summary for all players
- unlock room

### Disconnect And Reconnect Rules

When a player disconnects during active game:
- mark them disconnected in room presence
- pause game immediately
- emit `game.paused`
- persist disconnect event

When the same authenticated user reconnects:
- bind new socket to existing player presence
- restore personalized snapshot
- if all required active players are connected again, emit `game.resumed`

Host disconnect policy:
- if the host disconnects, the game still pauses like any other player
- do not auto-transfer host on ordinary disconnect
- if the host is force-removed, transfer host deterministically before returning room to lobby state

When host force-removes:
- only allowed while game is paused for disconnect
- terminate current game as `unfinished`

### Security Invariants

- the DO must trust authenticated user identity from verified Worker context, not raw client payload
- every action must validate room role and phase
- do not let client choose hidden outcomes
- do not echo unauthorized role data in general broadcast events
- replay endpoints must filter hidden event payloads if viewer should not see them

### Shared Type Additions

Add to `packages/shared/src/room.ts`:
- room snapshot types
- player presence vs spectator presence payloads
- websocket client event union
- websocket server event union

Add to `packages/shared/src/game.ts`:
- richer active game state
- role visibility payloads
- round tracker
- reject tracker
- pending vote structures
- replay event types

### Implementation Order

The original execution order above has mostly been completed already. For the next agent, the practical order is now:

1. confirm whether the task is frontend delivery, backend bugfixing, or test coverage
2. if frontend delivery:
   - build authenticated flows
   - build room lobby + websocket hydration
   - build active game UI and replay/history UI
3. if backend hardening:
   - add integration coverage for auth, room lifecycle, websocket session identity, and replay filtering
   - clean up remaining contract drift such as the unhandled `room.end-game` event
4. only revisit game-state behavior if a concrete rules bug is identified

### Acceptance Checks

- two clients in one room receive synchronized lobby updates
- only host can start game
- room rejects new joiners while locked
- players receive only authorized role information
- spectators can view all roles
- rejected teams rotate leader and track hammer count correctly
- Mission 4 uses two-fail logic for 7+ players only
- disconnect pauses the game
- reconnect restores the player to the active game
- host force-removal records unfinished history correctly
- completed and unfinished games are visible from room history

## Split Docs

The following focused handoff documents exist alongside this summary:

- `docs/database-handoff.md`
- `docs/auth-handoff.md`
- `docs/realtime-handoff.md`
- `docs/api-examples.md`
- `docs/implementation-checklist.md`
- `docs/shared-contract-targets.md`
- `docs/rules-gap-review.md`

## Out Of Scope For This Handoff

Do not add these unless explicitly requested later:
- chat
- timers
- social graph or friends
- password reset flow
- moderation/admin tooling
- analytics
