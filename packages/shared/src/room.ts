import type {
  ActiveGameView,
  GameReplayResponse,
  GameSummary,
  UserHistoryGameSummary,
  MissionResult,
  ProposalRecord,
  QuestVote,
  RoundTracker,
  Role,
  GameStatus,
  Team,
  TeamVote,
  TeamVoteRecord,
  ViewerSecretState
} from "./game";

export type RoomVisibility = "open" | "locked";
export type PresenceRole = "host" | "player" | "spectator";

export interface RoomIdentity {
  id: string;
  code: string;
  name: string;
  visibility: RoomVisibility;
  hostId: string;
}

export interface RoomSummary {
  id: string;
  code: string;
  name: string;
  visibility: RoomVisibility;
  hostId: string;
  playerCount: number;
  spectatorCount: number;
  hasActiveGame: boolean;
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

export interface RoomSeat {
  seat: number;
  userId: string;
  displayName: string;
  connected: boolean;
}

export interface RoomPresence {
  userId: string;
  displayName: string;
  role: PresenceRole;
  connected: boolean;
}

export interface RoomSnapshotEventPayload {
  room: RoomIdentity;
  players: PlayerPresence[];
  spectators: SpectatorPresence[];
  seats: RoomSeat[];
  lockStatus: RoomVisibility;
  activeGame: ActiveGameView | null;
  activityLog: RoomActivityItem[];
  viewerSecretState: ViewerSecretState | null;
  viewerActionState: {
    teamVoteSubmitted: boolean;
    questVoteSubmitted: boolean;
  } | null;
}

export interface RoomActivityItem {
  id: string;
  occurredAt: string;
  message: string;
}

export interface CreateRoomRequest {
  name: string;
}

export interface CreateRoomResponse {
  room: RoomSummary;
  inviteUrl: string;
}

export interface JoinRoomRequest {
  roomCode?: string;
  inviteToken?: string;
  asSpectator?: boolean;
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

export interface RecentRoomResponse {
  room: RoomSummary | null;
}

export interface UserHistoryResponse {
  games: UserHistoryGameSummary[];
}

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
  | { type: "room.end-game"; payload: { roomId: string } }
  | { type: "room.reveal-disconnected"; payload: { targetUserId: string } }
  | { type: "game.advance-to-proposal"; payload: { gameId: string } }
  | { type: "game.propose-team"; payload: { gameId: string; teamUserIds: string[] } }
  | { type: "game.submit-team-vote"; payload: { gameId: string; vote: TeamVote } }
  | { type: "game.submit-quest-vote"; payload: { gameId: string; vote: QuestVote } }
  | { type: "game.submit-assassination"; payload: { gameId: string; targetUserId: string } }
  | { type: "game.send-predefined-chat"; payload: { gameId: string; sentence: string } }
  | { type: "game.request-role-reveal"; payload: { gameId: string } };

export type RoomServerEvent =
  | {
      type: "room.snapshot";
      occurredAt: string;
      payload: RoomSnapshotEventPayload;
    }
  | {
      type: "room.presence.updated";
      occurredAt: string;
      payload: {
        roomId: string;
        players: PlayerPresence[];
        spectators: SpectatorPresence[];
      };
    }
  | {
      type: "room.host.updated";
      occurredAt: string;
      payload: { roomId: string; hostUserId: string };
    }
  | {
      type: "room.seating.updated";
      occurredAt: string;
      payload: { roomId: string; seats: RoomSeat[] };
    }
  | {
      type: "room.locked";
      occurredAt: string;
      payload: { roomId: string };
    }
  | {
      type: "room.unlocked";
      occurredAt: string;
      payload: { roomId: string };
    }
  | {
      type: "game.phase.changed";
      occurredAt: string;
      payload: {
        gameId: string;
        phase: GameStatus;
        round: number;
        attempt: number;
        leaderUserId: string;
      };
    }
  | {
      type: "game.team.proposed";
      occurredAt: string;
      payload: ProposalRecord;
    }
  | {
      type: "game.team.vote.revealed";
      occurredAt: string;
      payload: {
        gameId: string;
        round: number;
        attempt: number;
        votes: TeamVoteRecord[];
        approved: boolean;
        rejectTracker: number;
      };
    }
  | {
      type: "game.quest.result.revealed";
      occurredAt: string;
      payload: MissionResult & {
        gameId: string;
        score: { good: number; evil: number };
        cards: QuestVote[];
      };
    }
  | {
      type: "game.paused";
      occurredAt: string;
      payload: { gameId: string; disconnectedUserId: string; reason: "player_disconnected" };
    }
  | {
      type: "game.resumed";
      occurredAt: string;
      payload: { gameId: string };
    }
  | {
      type: "game.assassination.started";
      occurredAt: string;
      payload: { gameId: string; assassinUserId: string; candidateUserIds: string[] };
    }
  | {
      type: "game.predefined-chat.sent";
      occurredAt: string;
      payload: {
        gameId: string;
        senderDisplayName: string;
        senderUserId: string;
        sentence: string;
      };
    }
  | {
      type: "game.finished";
      occurredAt: string;
      payload: { gameId: string; winner: Team | null };
    }
  | {
      type: "game.terminated";
      occurredAt: string;
      payload: {
        gameId: string;
        status: "unfinished";
        reason: "host_force_removed_disconnected_player" | "host_ended_game";
      };
    }
  | {
      type: "history.game.available";
      occurredAt: string;
      payload: { roomId: string; game: GameSummary };
    }
  | {
      type: "error";
      occurredAt: string;
      payload: { code: string; message: string };
    };

export type RoomEvent = RoomServerEvent;

export type { GameReplayResponse, RoundTracker };
