# Implementation Checklist

This is the execution checklist for the next agent.

Status note as of 2026-05-22:

- Phases 1 through 12 are substantially implemented in the backend.
- Current compile/build verification passes.
- The practical remaining work is frontend delivery, runtime/integration testing, and cleanup of small contract drift.
- Treat the phase lists below as audit checklists now, not as a fresh greenfield plan.

## Phase 1: Shared Contracts

- Expand `packages/shared/src/auth.ts` with:
  - `AuthMeResponse`
  - `AuthErrorResponse`
  - `AuthenticatedUserClaims`
- Expand `packages/shared/src/room.ts` with:
  - room snapshot payload
  - player presence payload
  - spectator presence payload
  - room client event union
  - room server event union
- Expand `packages/shared/src/game.ts` with:
  - active game state
  - viewer secret state
  - role visibility payload
  - reject tracker
  - round tracker
  - replay event payload types
- Verify shared package still typechecks

Exit criteria:
- all new contract types compile
- API and WebSocket shapes match `docs/api-examples.md`

## Phase 2: Database

- Create `apps/api/migrations/0001_initial.sql`
- Create `apps/api/migrations/0002_indexes.sql`
- Add tables:
  - `users`
  - `rooms`
  - `room_members`
  - `room_spectators`
  - `games`
  - `game_players`
  - `game_events`
- Add required uniqueness and composite keys
- Add required indexes
- Decide whether to add foreign keys in D1 schema
- Document normalized username storage

Exit criteria:
- migration files are present
- schema supports signup, room creation, game history, and replay logs
- unfinished games can be persisted

## Phase 3: Auth

- Add password hashing helper that works in Workers
- Add JWT signing and verification helper
- Add auth middleware
- Implement `POST /api/auth/signup`
- Implement `POST /api/auth/login`
- Implement `GET /api/auth/me`
- Protect:
  - room creation
  - room join
  - room actions
  - history endpoints
  - replay endpoints
  - WebSocket upgrade

Exit criteria:
- signup returns token and user
- login returns token and user
- invalid credentials fail with `401`
- duplicate username fails with `409`
- protected routes reject invalid or missing tokens

## Phase 4: Room Lifecycle

- Implement room code generator with collision retry
- Implement invite token generator with collision retry
- Implement `POST /api/rooms`
- Implement `POST /api/rooms/join`
- Implement `GET /api/rooms/:roomId`
- Reject joins when room is locked
- Ensure room join supports player vs spectator
- Ensure locked room rejects spectators too

Exit criteria:
- authenticated user can create room
- authenticated user can join room as player or spectator while open
- locked room rejects all joins

## Phase 5: WebSocket Connect And Snapshot

- Implement `GET /api/rooms/:roomId/ws`
- Bind authenticated user identity into DO session
- Emit personalized `room.snapshot` on connect
- Track connected player presence
- Track connected spectator presence
- Support reconnect by authenticated user id

Exit criteria:
- two clients can connect to same room
- both receive synchronized lobby updates
- reconnect restores prior room identity

## Phase 6: Lobby Host Actions

- Implement host-only actions:
  - transfer host
  - kick player
  - randomize seats
  - reveal disconnected player
- Define deterministic host transfer fallback
- Remove kicked players from live room membership

Exit criteria:
- non-host cannot execute host actions
- host transfer updates room snapshot
- kicked user disappears from room presence

## Phase 7: Game Setup

- Validate player count 5 to 10
- Validate selected roles against `rules.md`
- Randomly assign roles
- Compute private visibility maps
- Persist `games` row
- Persist `game_players` snapshot
- Persist starting events
- Lock room
- Enter `night`

Exit criteria:
- host can start valid game
- invalid role composition is rejected
- each viewer receives only allowed secret information

## Phase 8: Proposal And Team Vote

- Implement leader rotation
- Implement mission-size validation by round and player count
- Implement hidden team voting
- Reveal votes only after all active players vote
- Track reject counter
- Trigger evil win at 5 consecutive rejections

Exit criteria:
- only current leader can propose
- ties reject the team
- hammer logic is correct

## Phase 9: Quest Vote

- Restrict quest vote to approved quest team
- Restrict good players to `success`
- Allow evil players `success` or `fail`
- Shuffle revealed cards
- Apply Mission 4 two-fail rule for 7+ players only
- Update mission score

Exit criteria:
- quest votes are hidden until complete
- card reveal order is not submission order
- mission scoring matches `rules.md`

## Phase 10: Assassination And Finish

- Enter assassination after 3 good missions
- Restrict action to assassin only
- Finish evil win if Merlin is targeted
- Finish good win otherwise
- Persist final role reveal
- Unlock room
- Clear `active_game_id`

Exit criteria:
- assassination only appears when good reaches 3 missions
- finished game is queryable in history

## Phase 11: Disconnect And Forced Termination

- Pause game on active-player disconnect
- Persist disconnect event
- Resume only when all required players return
- Support host force-remove on disconnected player
- Mark terminated game as `unfinished`
- Persist termination event and summary
- Unlock room after termination

Exit criteria:
- active disconnect pauses game
- reconnect resumes when complete
- host can terminate disconnected game
- terminated game appears as `unfinished`

## Phase 12: Replay And History

- Implement `GET /api/rooms/:roomId/history`
- Implement `GET /api/games/:gameId`
- Return replayable event log
- Filter hidden events by viewer authorization
- Allow spectators to see all roles in replay

Exit criteria:
- players can open room history
- replay timeline is ordered and complete
- unauthorized hidden data is filtered correctly

## Next Agent Checklist

- Verify the task is actually backend work before changing the implemented server flow
- If building UI, wire `apps/web` to:
  - auth endpoints
  - room create/join flows
  - websocket room snapshots and live events
  - active game actions and replay/history screens
- If hardening backend, add runtime or integration tests for:
  - signup/login/auth middleware
  - room create/join/locked-room rules
  - websocket reconnect identity binding
  - replay/history access control
  - spectator replay visibility
  - disconnect pause/resume and forced termination
- Reconcile shared contract drift:
  - keep the handoff docs aligned with the implemented websocket contract before adding more client behavior
