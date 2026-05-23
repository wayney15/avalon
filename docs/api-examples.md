# API And Event Examples

This document gives concrete payload examples for the next agent. These are examples, not generated code.

## HTTP Examples

### `POST /api/auth/signup`

Request:

```json
{
  "username": "arthur_host",
  "displayName": "Arthur",
  "password": "correct horse battery staple"
}
```

Success response:

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "usr_01jvavalon",
    "username": "arthur_host",
    "displayName": "Arthur"
  }
}
```

Duplicate username response:

```json
{
  "error": "username_taken",
  "message": "That username is already in use."
}
```

### `POST /api/auth/login`

Request:

```json
{
  "username": "arthur_host",
  "password": "correct horse battery staple"
}
```

Success response:

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "usr_01jvavalon",
    "username": "arthur_host",
    "displayName": "Arthur"
  }
}
```

### `GET /api/auth/me`

Success response:

```json
{
  "user": {
    "id": "usr_01jvavalon",
    "username": "arthur_host",
    "displayName": "Arthur"
  }
}
```

### `POST /api/rooms`

Request:

```json
{
  "name": "Friday Avalon"
}
```

Success response:

```json
{
  "room": {
    "id": "room_01jvroom",
    "code": "K7M4Q",
    "name": "Friday Avalon",
    "visibility": "open",
    "hostId": "usr_01jvavalon",
    "playerCount": 1,
    "spectatorCount": 0,
    "hasActiveGame": false
  },
  "inviteUrl": "https://example.com/rooms/invite/inv_01jvtoken"
}
```

### `POST /api/rooms/join`

Player join request:

```json
{
  "roomCode": "K7M4Q",
  "asSpectator": false
}
```

Spectator join request:

```json
{
  "roomCode": "K7M4Q",
  "asSpectator": true
}
```

Locked room response:

```json
{
  "error": "room_locked",
  "message": "This room is locked while a game is in progress."
}
```

### `GET /api/rooms/:roomId`

Success response:

```json
{
  "room": {
    "id": "room_01jvroom",
    "code": "K7M4Q",
    "name": "Friday Avalon",
    "visibility": "open",
    "hostId": "usr_01jvavalon",
    "playerCount": 6,
    "spectatorCount": 1,
    "hasActiveGame": false
  },
  "inviteUrl": "https://example.com/rooms/invite/inv_01jvtoken"
}
```

### `GET /api/rooms/:roomId/history`

Success response:

```json
{
  "games": [
    {
      "id": "game_01jvgame",
      "roomId": "room_01jvroom",
      "status": "finished",
      "startedAt": "2026-05-21T19:00:00.000Z",
      "endedAt": "2026-05-21T19:32:00.000Z",
      "winner": "good"
    },
    {
      "id": "game_01jvunfinished",
      "roomId": "room_01jvroom",
      "status": "unfinished",
      "startedAt": "2026-05-21T20:00:00.000Z",
      "endedAt": "2026-05-21T20:11:00.000Z",
      "winner": null
    }
  ]
}
```

## WebSocket Examples

### Client event: `room.connect`

```json
{
  "type": "room.connect",
  "payload": {
    "roomId": "room_01jvroom"
  }
}
```

### Server event: `room.snapshot`

Player-scoped snapshot example:

```json
{
  "type": "room.snapshot",
  "occurredAt": "2026-05-21T19:00:02.000Z",
  "payload": {
    "room": {
      "id": "room_01jvroom",
      "code": "K7M4Q",
      "name": "Friday Avalon",
      "visibility": "open",
      "hostId": "usr_01jvavalon"
    },
    "players": [
      {
        "userId": "usr_01jvavalon",
        "displayName": "Arthur",
        "role": "host",
        "connected": true
      },
      {
        "userId": "usr_01jvmerlin",
        "displayName": "MerlinMain",
        "role": "player",
        "connected": true
      }
    ],
    "spectators": [
      {
        "userId": "usr_01jvspec",
        "displayName": "Watcher",
        "role": "spectator",
        "connected": true
      }
    ],
    "seats": [
      {
        "seat": 0,
        "userId": "usr_01jvavalon",
        "displayName": "Arthur",
        "connected": true
      },
      {
        "seat": 1,
        "userId": "usr_01jvmerlin",
        "displayName": "MerlinMain",
        "connected": true
      }
    ],
    "lockStatus": "open",
    "activeGame": null,
    "viewerSecretState": null
  }
}
```

### Client event: `room.start-game`

```json
{
  "type": "room.start-game",
  "payload": {
    "roles": [
      "merlin",
      "percival",
      "loyal-servant",
      "assassin",
      "morgana"
    ]
  }
}
```

### Server event: `game.phase.changed`

```json
{
  "type": "game.phase.changed",
  "occurredAt": "2026-05-21T19:01:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "phase": "night",
    "round": 1,
    "attempt": 1,
    "leaderUserId": "usr_01jvavalon"
  }
}
```

### Server event: `room.snapshot` during night for a player

```json
{
  "type": "room.snapshot",
  "occurredAt": "2026-05-21T19:01:01.000Z",
  "payload": {
    "activeGame": {
      "id": "game_01jvgame",
      "status": "night"
    },
    "viewerSecretState": {
      "role": "percival",
      "team": "good",
      "visiblePlayers": [
        {
          "userId": "usr_01jvmerlin",
          "displayName": "MerlinMain",
          "reason": "merlin_or_morgana"
        },
        {
          "userId": "usr_01jvmorgana",
          "displayName": "BluffQueen",
          "reason": "merlin_or_morgana"
        }
      ],
      "revealMode": "press-and-hold"
    }
  }
}
```

### Client event: `game.advance-to-proposal`

```json
{
  "type": "game.advance-to-proposal",
  "payload": {
    "gameId": "game_01jvgame"
  }
}
```

### Client event: `game.propose-team`

```json
{
  "type": "game.propose-team",
  "payload": {
    "gameId": "game_01jvgame",
    "teamUserIds": [
      "usr_01jvavalon",
      "usr_01jvmerlin"
    ]
  }
}
```

### Server event: `game.team.proposed`

```json
{
  "type": "game.team.proposed",
  "occurredAt": "2026-05-21T19:03:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "round": 1,
    "attempt": 1,
    "leaderUserId": "usr_01jvavalon",
    "teamUserIds": [
      "usr_01jvavalon",
      "usr_01jvmerlin"
    ]
  }
}
```

### Client event: `game.submit-team-vote`

```json
{
  "type": "game.submit-team-vote",
  "payload": {
    "gameId": "game_01jvgame",
    "vote": "approve"
  }
}
```

### Server event: `game.team.vote.revealed`

```json
{
  "type": "game.team.vote.revealed",
  "occurredAt": "2026-05-21T19:04:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "round": 1,
    "attempt": 1,
    "votes": [
      {
        "userId": "usr_01jvavalon",
        "vote": "approve"
      },
      {
        "userId": "usr_01jvmerlin",
        "vote": "approve"
      },
      {
        "userId": "usr_01jvmorgana",
        "vote": "reject"
      }
    ],
    "approved": true,
    "rejectTracker": 0
  }
}
```

### Client event: `game.submit-quest-vote`

```json
{
  "type": "game.submit-quest-vote",
  "payload": {
    "gameId": "game_01jvgame",
    "vote": "success"
  }
}
```

### Server event: `game.quest.result.revealed`

```json
{
  "type": "game.quest.result.revealed",
  "occurredAt": "2026-05-21T19:05:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "round": 1,
    "missionSize": 2,
    "cards": [
      "success",
      "success"
    ],
    "successCount": 2,
    "failCount": 0,
    "winner": "good",
    "score": {
      "good": 1,
      "evil": 0
    }
  }
}
```

### Server event: `game.paused`

```json
{
  "type": "game.paused",
  "occurredAt": "2026-05-21T19:08:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "disconnectedUserId": "usr_01jvmerlin",
    "reason": "player_disconnected"
  }
}
```

### Server event: `game.terminated`

```json
{
  "type": "game.terminated",
  "occurredAt": "2026-05-21T19:12:00.000Z",
  "payload": {
    "gameId": "game_01jvgame",
    "status": "unfinished",
    "reason": "host_force_removed_disconnected_player"
  }
}
```

## Error Event Example

```json
{
  "type": "error",
  "occurredAt": "2026-05-21T19:03:01.000Z",
  "payload": {
    "code": "not_current_leader",
    "message": "Only the current leader can propose a team."
  }
}
```
