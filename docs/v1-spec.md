# Avalon Web V1 Spec

## Product Summary

Avalon Web is a lightweight mobile-first web application for hosting private games of The Resistance: Avalon for 5 to 10 players. Users create accounts, join rooms via invite link or room code, gather in a visible lobby, and play a backend-authoritative real-time game over WebSockets.

## V1 Scope

- Self-signup with unique username, separate display name, and JWT-based authenticated sessions
- Private rooms with room code and invite link
- Open room lobby that shows joined players and spectators
- Host-controlled game lifecycle
- Spectator support in lobby and in-game
- Multiple games under one room
- Replayable game history visible from the room UI

## Core Room Rules

- Any signed-in user can create a room and become its host
- The host can kick players, transfer host, start game, end game, and reveal disconnected players
- A room becomes locked only during an active game
- While locked, nobody new can join the room
- After each finished game, the room returns to the open lobby with the same current group, and the host can randomize all seats before the next game

## Gameplay Rules

- Source of truth: `rules.md`
- The app must enforce official player-count role and mission distributions from `rules.md`
- Role support for v1 follows the current rule set in `rules.md`
- The backend is authoritative for all hidden information and state transitions
- No in-game chat in v1
- No timers in v1

## Sensitive UX Rules

- Initial role and secret information use press-and-hold reveal
- Irreversible actions, especially assassination, require explicit confirmation

## Disconnect Rules

- If a player disconnects mid-game, the game pauses
- The player can auto-reconnect into the same room and game
- The host can force-remove a disconnected player and terminate the current game
- A terminated game is persisted as `UnFinished` for every player in that game

## Persistence

- Persist users, rooms, memberships, and game summaries in D1
- Persist replayable event logs for every game
- Store proposal history, public votes, quest results, assassinations, and final roles
- Past games are visible from the room UI to all players

## Architecture Summary

- `apps/web`: React SPA optimized for mobile
- `apps/api`: Hono Worker for HTTP auth and room APIs
- Durable Object per room for authoritative lobby and game coordination
- `packages/shared`: shared TypeScript types for API payloads, room events, and game state
