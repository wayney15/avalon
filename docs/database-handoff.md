# Database Handoff

This document isolates the D1 workstream from the broader implementation handoff.

## Deliverables

- `apps/api/migrations/0001_initial.sql`
- `apps/api/migrations/0002_indexes.sql`
- optional data-access helpers under `apps/api/src`

## Required Tables

### `users`

- `id TEXT PRIMARY KEY`
- `username TEXT NOT NULL UNIQUE`
- `display_name TEXT NOT NULL`
- `password_hash TEXT NOT NULL`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Rule:
- persist normalized lowercase username

### `rooms`

- `id TEXT PRIMARY KEY`
- `code TEXT NOT NULL UNIQUE`
- `invite_token TEXT NOT NULL UNIQUE`
- `name TEXT NOT NULL`
- `host_user_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `active_game_id TEXT`
- `created_at TEXT NOT NULL`
- `updated_at TEXT NOT NULL`

Expected `status` values:
- `open`
- `locked`
- `archived`

### `room_members`

- `room_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `seat_index INTEGER`
- `joined_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- `is_host INTEGER NOT NULL`
- primary key: `(room_id, user_id)`

### `room_spectators`

- `room_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `joined_at TEXT NOT NULL`
- `last_seen_at TEXT NOT NULL`
- primary key: `(room_id, user_id)`

### `games`

- `id TEXT PRIMARY KEY`
- `room_id TEXT NOT NULL`
- `status TEXT NOT NULL`
- `player_count INTEGER NOT NULL`
- `host_user_id TEXT NOT NULL`
- `started_at TEXT NOT NULL`
- `ended_at TEXT`
- `ended_reason TEXT`
- `winner TEXT`
- `mission_wins_good INTEGER NOT NULL DEFAULT 0`
- `mission_wins_evil INTEGER NOT NULL DEFAULT 0`

Expected `status` values:
- `in_progress`
- `finished`
- `unfinished`

### `game_players`

- `game_id TEXT NOT NULL`
- `user_id TEXT NOT NULL`
- `display_name_snapshot TEXT NOT NULL`
- `seat_index INTEGER NOT NULL`
- `role TEXT NOT NULL`
- `team TEXT NOT NULL`
- `is_host INTEGER NOT NULL`
- `final_outcome TEXT NOT NULL`
- primary key: `(game_id, user_id)`

### `game_events`

- `id TEXT PRIMARY KEY`
- `game_id TEXT NOT NULL`
- `sequence_no INTEGER NOT NULL`
- `event_type TEXT NOT NULL`
- `actor_user_id TEXT`
- `visible_to TEXT NOT NULL`
- `subject_user_id TEXT`
- `payload_json TEXT NOT NULL`
- `created_at TEXT NOT NULL`

Constraint:
- unique `(game_id, sequence_no)`

## Required Event Types

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

## Indexes

- `users(username)`
- `rooms(code)`
- `rooms(invite_token)`
- `rooms(host_user_id)`
- `games(room_id, started_at DESC)`
- `game_events(game_id, sequence_no)`
- `room_members(room_id, seat_index)`

## Edge Cases

- room code generation must retry on collision
- invite token generation must retry on collision
- kicked players must be removed from current membership tables
- force-terminated games must persist as `unfinished`
- replay queries must reconstruct timelines from ordered `sequence_no`

## Acceptance Checks

- signup can insert one user and reject duplicate username
- room creation can insert a unique room code and invite token
- a game can snapshot all players into `game_players`
- a game can store ordered replayable events
- a terminated game appears in room history as `unfinished`
