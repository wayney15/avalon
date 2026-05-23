# Shared Contract Targets

This document defines the TypeScript interface targets that the next agent should add to `packages/shared`.

These are targets, not implemented code.

## Auth Targets

```ts
export interface AuthErrorResponse {
  error: string;
  message: string;
}

export interface AuthenticatedUserClaims {
  sub: string;
  iss: string;
  iat: number;
  exp: number;
  username?: string;
  displayName?: string;
}

export interface AuthMeResponse {
  user: AuthUser;
}
```

## Room Snapshot Targets

```ts
export interface RoomIdentity {
  id: string;
  code: string;
  name: string;
  visibility: "open" | "locked";
  hostId: string;
}

export interface PlayerPresence {
  userId: string;
  displayName: string;
  role: "host" | "player";
  connected: boolean;
}

export interface SpectatorPresence {
  userId: string;
  displayName: string;
  role: "spectator";
  connected: boolean;
}

export interface ViewerVisiblePlayer {
  userId: string;
  displayName: string;
  reason:
    | "known-evil"
    | "merlin-or-morgana"
    | "known-teammate"
    | "all-roles-visible-to-spectator";
}

export interface ViewerSecretState {
  role: Role;
  team: Team;
  visiblePlayers: ViewerVisiblePlayer[];
  revealMode: "press-and-hold";
}

export interface ActiveGameView {
  id: string;
  status: GameStatus;
  round: number;
  attempt: number;
  leaderUserId: string;
  rejectTracker: number;
  missionScores: {
    good: number;
    evil: number;
  };
}

export interface RoomSnapshotEventPayload {
  room: RoomIdentity;
  players: PlayerPresence[];
  spectators: SpectatorPresence[];
  seats: RoomSeat[];
  lockStatus: "open" | "locked";
  activeGame: ActiveGameView | null;
  viewerSecretState: ViewerSecretState | null;
}
```

## HTTP Targets

```ts
export interface CreateRoomResponse {
  room: RoomSummary;
  inviteUrl: string;
}

export interface JoinRoomResponse {
  room: RoomSummary;
}

export interface RoomDetailResponse {
  room: RoomSummary;
  inviteUrl: string;
}

export interface RoomHistoryResponse {
  games: GameSummary[];
}
```

## WebSocket Client Event Targets

```ts
export type RoomClientEvent =
  | { type: "room.connect"; payload: { roomId: string } }
  | { type: "room.leave"; payload: { roomId: string } }
  | { type: "room.join-player"; payload: { roomId: string } }
  | { type: "room.join-spectator"; payload: { roomId: string } }
  | { type: "room.seat-swap"; payload: { leftSeat: number; rightSeat: number } }
  | { type: "room.randomize-seats"; payload: { roomId: string } }
  | { type: "room.transfer-host"; payload: { targetUserId: string } }
  | { type: "room.kick-player"; payload: { targetUserId: string } }
  | { type: "room.start-game"; payload: { roles: Role[] } }
  | { type: "room.reveal-disconnected"; payload: { targetUserId: string } }
  | { type: "game.advance-to-proposal"; payload: { gameId: string } }
  | { type: "game.propose-team"; payload: { gameId: string; teamUserIds: string[] } }
  | { type: "game.submit-team-vote"; payload: { gameId: string; vote: TeamVote } }
  | { type: "game.submit-quest-vote"; payload: { gameId: string; vote: QuestVote } }
  | { type: "game.submit-assassination"; payload: { gameId: string; targetUserId: string } }
  | { type: "game.request-role-reveal"; payload: { gameId: string } };
```

## WebSocket Server Event Targets

```ts
export type RoomServerEvent =
  | { type: "room.snapshot"; occurredAt: string; payload: RoomSnapshotEventPayload }
  | { type: "room.presence.updated"; occurredAt: string; payload: { roomId: string; players: PlayerPresence[]; spectators: SpectatorPresence[] } }
  | { type: "room.host.updated"; occurredAt: string; payload: { roomId: string; hostUserId: string } }
  | { type: "room.seating.updated"; occurredAt: string; payload: { roomId: string; seats: RoomSeat[] } }
  | { type: "room.locked"; occurredAt: string; payload: { roomId: string } }
  | { type: "room.unlocked"; occurredAt: string; payload: { roomId: string } }
  | { type: "game.phase.changed"; occurredAt: string; payload: { gameId: string; phase: GameStatus; round: number; attempt: number; leaderUserId: string } }
  | { type: "game.team.proposed"; occurredAt: string; payload: ProposalRecord }
  | { type: "game.team.vote.revealed"; occurredAt: string; payload: { gameId: string; round: number; attempt: number; votes: TeamVoteRecord[]; approved: boolean; rejectTracker: number } }
  | { type: "game.quest.result.revealed"; occurredAt: string; payload: MissionResult & { gameId: string; score: { good: number; evil: number }; cards: QuestVote[] } }
  | { type: "game.paused"; occurredAt: string; payload: { gameId: string; disconnectedUserId: string; reason: "player_disconnected" } }
  | { type: "game.resumed"; occurredAt: string; payload: { gameId: string } }
  | { type: "game.assassination.started"; occurredAt: string; payload: { gameId: string; assassinUserId: string; candidateUserIds: string[] } }
  | { type: "game.finished"; occurredAt: string; payload: { gameId: string; winner: Team | null } }
  | { type: "game.terminated"; occurredAt: string; payload: { gameId: string; status: "unfinished"; reason: "host_force_removed_disconnected_player" } }
  | { type: "history.game.available"; occurredAt: string; payload: { roomId: string; game: GameSummary } }
  | { type: "error"; occurredAt: string; payload: { code: string; message: string } };
```

## Replay Targets

```ts
export interface ReplayEvent<TPayload = unknown> {
  id: string;
  gameId: string;
  sequenceNo: number;
  eventType: string;
  actorUserId: string | null;
  visibleTo: "all" | "host" | "evil" | "good" | "self" | "spectators" | "system";
  subjectUserId: string | null;
  payload: TPayload;
  createdAt: string;
}

export interface GameReplayResponse {
  game: GameSummary;
  events: ReplayEvent[];
}
```
