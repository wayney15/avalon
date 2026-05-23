# Realtime And Game Handoff

This document isolates the Durable Object and realtime game orchestration workstream.

## Deliverables

- `apps/api/src/room-coordinator.ts`
- `apps/api/src/room-state.ts`
- `apps/api/src/room-events.ts`
- `apps/api/src/game-rules.ts`
- updates to `apps/api/src/index.ts`
- shared contract expansion in `packages/shared/src/room.ts`
- shared contract expansion in `packages/shared/src/game.ts`

## Durable Object Responsibilities

- authoritative room lobby presence
- authoritative player seating
- authoritative host identity
- authoritative room lock state
- authoritative active game state
- pause/resume behavior on disconnect
- realtime event fanout

## Worker Routes

- `POST /api/rooms`
- `POST /api/rooms/join`
- `GET /api/rooms/:roomId`
- `GET /api/rooms/:roomId/history`
- `GET /api/games/:gameId`
- `GET /api/rooms/:roomId/ws`

Rule:
- while room status is `locked`, reject all joins, including spectators

## Required WebSocket Client Events

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

## Required WebSocket Server Events

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

## Room Snapshot Requirements

Must include:
- room metadata
- host user id
- players
- spectators
- seat order
- lock status
- active game summary
- current phase
- viewer-specific secret state

Rules:
- snapshot is personalized per authenticated user
- unauthorized players cannot see hidden role information
- spectators can see all roles

## Game Phases

- `lobby`
- `night`
- `proposal`
- `team-vote`
- `quest-vote`
- `assassination`
- `finished`
- `unfinished`

## Required State Machine Behavior

### Start Game

- host only
- player count 5 to 10
- role pool must satisfy `rules.md`
- random role assignment
- compute private visibility
- lock room
- create persistent game summary and roster
- enter `night`

### Proposal

- only current leader may propose
- enforce mission team size by player count and round
- persist proposal event

### Team Vote

- all active players vote
- reveal only after all votes submitted
- if rejected:
  - increment reject tracker
  - rotate leader
  - evil wins immediately at 5 consecutive rejections
- if approved:
  - reset reject tracker
  - proceed to quest vote

### Quest Vote

- only approved quest members vote
- good can only submit `success`
- evil may submit `success` or `fail`
- shuffle result representation before broadcast
- mission 4 requires two fails only for 7+ player games

### Assassination

- assassin only
- one target
- explicit confirmation on client side
- evil wins if target is Merlin

### Finish And Termination

- finished game unlocks room and clears active game
- host may randomize seats for next game
- forced removal of a disconnected player terminates current game as `unfinished`

## Disconnect Rules

- any active-player disconnect pauses the game immediately
- reconnect restores the same authenticated user to prior presence
- if all required players are back, the game resumes
- host ordinary disconnect does not auto-transfer host
- if host is force-removed, transfer host deterministically

## Security Invariants

- trust authenticated Worker identity, not raw client payload
- validate every action by phase and room role
- do not leak global role maps in broadcast events
- replay responses must filter hidden events per viewer

## Acceptance Checks

- two clients see synchronized lobby updates
- only host can start game
- locked room rejects new player and spectator joins
- hidden role information is filtered correctly
- spectators can view all roles
- hammer count works
- Mission 4 two-fail rule works for 7+ players only
- disconnect pauses game
- reconnect resumes game
- host force-removal records `unfinished` history
