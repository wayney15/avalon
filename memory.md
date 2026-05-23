# Project Memory

## Workspace

- Project parent folder: `/mnt/h/avalon`
- Project folder: `/mnt/h/avalon/project`

## Durable Context From Discussion

- Available skills in this session:
  - `imagegen`
  - `openai-docs`
  - `plugin-creator`
  - `skill-creator`
  - `skill-installer`
  - `karpathy-guidelines`
- Skills are enabled automatically when the task clearly matches a skill's description.
- A skill can also be forced by naming it explicitly in the request.
- The user does not need to restate the same skill choice for every agent when the task already matches.

## Karpathy Guidelines Trigger

Use `karpathy-guidelines` for coding tasks where it helps keep the work disciplined:

- Writing new code
- Reviewing code
- Refactoring code
- Debugging when the correct fix is not obvious

Primary intent:

- Keep changes surgical
- Avoid speculative abstractions
- Surface assumptions instead of guessing
- Define clear, verifiable success criteria

## Assumption

- Because no project name or stack was provided, the initial project folder was created as `/mnt/h/avalon/project`.

## Product Context

- Project type: lightweight web application
- Game: The Resistance: Avalon
- Intended usage: the application will be hosted online so the user and a small group of friends can join through the web
- Target player count: 5 to 10 players
- Gameplay requirement: real-time multiplayer over WebSockets
- Room model: invite link and room code
- Lobby model: open room lobby showing who has joined the room
- Rules source of truth: `/mnt/h/avalon/project/rules.md`
- Mobile-first support required from day one
- Backend must be authoritative for all game state
- No social layer beyond room code and invite link in v1

## Authentication Requirement

- Authentication approach: username + password
- Account model: self-signup allowed
- Usernames must be unique globally
- Display names are separate from login usernames
- After sign-in, clients should use a JWT token on subsequent requests
- Authentication is meant to identify each player in the application

## Room And Host Model

- Any signed-in user can create and control a room as host
- Host powers:
  - Kick players
  - Transfer host
  - Start game
  - End game
  - Reveal disconnected players
- A room locks automatically only while a game is active
- Multiple games can be played under one room history
- After each game, the room remains available with the same current group, and the host can randomize seats for the next game

## Gameplay Decisions

- Version 1 role support should match `rules.md`
- Enforce exact official player-count role distributions from `rules.md`
- No timers in v1
- No in-game chat in v1
- Spectators are allowed
- Spectators can see all roles
- Spectators are allowed in the lobby as well as during games
- If a player disconnects mid-game, the app should support auto-reconnect and pause the game until the player returns
- If a disconnected player does not return, the host can force-remove that player and terminate the current game
- A force-terminated game must be recorded as `UnFinished` for all players in their history
- A room should only be locked during an active game
- While a room is locked, nobody can join the room

## Persistence And Audit

- Completed games must be persisted
- Persist full replayable event logs
- Persist audit/history for:
  - Team proposals
  - Vote outcomes
  - Quest results
  - Assassinations
  - Final role reveals after game end
- Players should be able to access past games from the room UI

## Secret Information UX

- Initial secret role and private information should use press-and-hold reveal
- Irreversible sensitive actions should use explicit confirmation
