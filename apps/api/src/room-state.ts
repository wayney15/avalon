import type {
  ActiveGameView,
  PlayerPresence,
  RoomActivityItem,
  RoomIdentity,
  RoomSeat,
  RoomSnapshotEventPayload,
  RoomVisibility,
  SpectatorPresence
} from "../../../packages/shared/src";
import { loadActiveGameState, loadActiveGameView, loadGamePlayerRoster, loadRoomViewerRole, loadViewerSecretState } from "./rooms";

interface RoomMetadataRow {
  id: string;
  code: string;
  name: string;
  hostUserId: string;
  status: "open" | "locked" | "archived";
  activeGameId: string | null;
}

interface MemberRow {
  userId: string;
  displayName: string;
  seatIndex: number | null;
  isHost: number;
}

interface SpectatorRow {
  userId: string;
  displayName: string;
}

interface ActivityEventRow {
  id: string;
  eventType: string;
  actorUserId: string | null;
  visibleTo: "all" | "host" | "evil" | "good" | "self" | "spectators" | "system";
  subjectUserId: string | null;
  payloadJson: string;
  createdAt: string;
}

export interface RoomPresenceState {
  room: RoomIdentity;
  players: PlayerPresence[];
  spectators: SpectatorPresence[];
  seats: RoomSeat[];
  lockStatus: RoomVisibility;
  activeGame: ActiveGameView | null;
}

function roomVisibility(status: RoomMetadataRow["status"]): RoomVisibility {
  return status === "open" ? "open" : "locked";
}

function canViewActivityEvent(
  event: ActivityEventRow,
  viewer: {
    isSpectator: boolean;
    isGameHost: boolean;
    team: "good" | "evil" | null;
    userId: string;
  }
): boolean {
  if (event.eventType === "game.state.updated") {
    return false;
  }

  if (viewer.isSpectator) {
    return true;
  }

  switch (event.visibleTo) {
    case "all":
    case "system":
      return true;
    case "host":
      return viewer.isGameHost;
    case "good":
    case "evil":
      return viewer.team === event.visibleTo;
    case "self":
      return event.subjectUserId === viewer.userId;
    case "spectators":
      return false;
    default:
      return false;
  }
}

function formatActivityEvent(
  event: ActivityEventRow,
  resolveName: (userId: string) => string
): RoomActivityItem | null {
  const payload = JSON.parse(event.payloadJson) as Record<string, unknown>;

  switch (event.eventType) {
    case "game.started":
      return {
        id: event.id,
        message: "房间已锁定，游戏进行中。",
        occurredAt: event.createdAt
      };
    case "team.proposed": {
      const leaderUserId = typeof payload.leaderUserId === "string" ? payload.leaderUserId : "";
      const teamUserIds = Array.isArray(payload.teamUserIds) ? payload.teamUserIds.filter((value): value is string => typeof value === "string") : [];
      return {
        id: event.id,
        message: `${resolveName(leaderUserId)} 提议队伍：${teamUserIds.map(resolveName).join("、")}。`,
        occurredAt: event.createdAt
      };
    }
    case "team.vote.revealed": {
      const votes = Array.isArray(payload.votes)
        ? payload.votes.filter(
            (value): value is { userId: string; vote: "approve" | "reject" } =>
              typeof value === "object" &&
              value !== null &&
              typeof value.userId === "string" &&
              (value.vote === "approve" || value.vote === "reject")
          )
        : [];
      const approvedBy = votes.filter((entry) => entry.vote === "approve").map((entry) => resolveName(entry.userId)).join(" ");
      const rejectedBy = votes.filter((entry) => entry.vote === "reject").map((entry) => resolveName(entry.userId)).join(" ");
      return {
        id: event.id,
        message:
          payload.approved === true
            ? `队伍表决通过。\n赞成 ✓：${approvedBy || "无人"}\n反对 ✗：${rejectedBy || "无人"}`
            : `队伍表决未通过。\n赞成 ✓：${approvedBy || "无人"}\n反对 ✗：${rejectedBy || "无人"}`,
        occurredAt: event.createdAt
      };
    }
    case "quest.result.revealed": {
      const round = typeof payload.round === "number" ? payload.round : 0;
      const winner = payload.winner === "good" ? "good" : "evil";
      const failCount = typeof payload.failCount === "number" ? payload.failCount : 0;
      return {
        id: event.id,
        message: `第 ${round} 次任务${winner === "good" ? "成功" : "失败"}，出现 ${failCount} 张失败票。`,
        occurredAt: event.createdAt
      };
    }
    case "player.disconnected": {
      const disconnectedUserId = typeof payload.disconnectedUserId === "string" ? payload.disconnectedUserId : "";
      return {
        id: event.id,
        message: `${resolveName(disconnectedUserId)} 已断线，游戏暂停。`,
        occurredAt: event.createdAt
      };
    }
    case "player.reconnected": {
      const reconnectedUserId = typeof payload.reconnectedUserId === "string" ? payload.reconnectedUserId : "";
      return {
        id: event.id,
        message: `${resolveName(reconnectedUserId)} 已重新连接。`,
        occurredAt: event.createdAt
      };
    }
    case "assassination.started": {
      const assassinUserId = typeof payload.assassinUserId === "string" ? payload.assassinUserId : "";
      return {
        id: event.id,
        message: `${resolveName(assassinUserId)} 正在选择刺杀目标。`,
        occurredAt: event.createdAt
      };
    }
    case "game.finished": {
      const winner = payload.winner;
      let message = "游戏结束。";
      if (winner === "good") {
        message = "游戏结束，好人胜利。";
      } else if (winner === "evil") {
        message = "游戏结束，坏人胜利。";
      }

      return {
        id: event.id,
        message,
        occurredAt: event.createdAt
      };
    }
    case "game.terminated":
      return {
        id: event.id,
        message:
          payload.reason === "host_ended_game"
            ? "房主结束了当前游戏。"
            : "房主强制移除玩家后，游戏已终止。",
        occurredAt: event.createdAt
      };
    default:
      return null;
  }
}

async function loadRecentActivityLog(
  db: D1Database,
  gameId: string,
  viewerUserId: string,
  viewerRole: "member" | "spectator"
): Promise<RoomActivityItem[]> {
  const [eventResult, roster] = await Promise.all([
    db
      .prepare(
        `SELECT
          id,
          event_type AS eventType,
          actor_user_id AS actorUserId,
          visible_to AS visibleTo,
          subject_user_id AS subjectUserId,
          payload_json AS payloadJson,
          created_at AS createdAt
        FROM game_events
        WHERE game_id = ?
        ORDER BY sequence_no DESC
        LIMIT 40`
      )
      .bind(gameId)
      .all<ActivityEventRow>(),
    loadGamePlayerRoster(db, gameId)
  ]);

  const viewerPlayer = roster.find((player) => player.userId === viewerUserId) ?? null;
  const playerNames = new Map(roster.map((player) => [player.userId, player.displayName]));
  const viewer = {
    isGameHost: viewerPlayer?.isHost === 1,
    isSpectator: viewerRole === "spectator",
    team: viewerPlayer?.team ?? null,
    userId: viewerUserId
  };

  return (eventResult.results ?? [])
    .filter((event) => canViewActivityEvent(event, viewer))
    .map((event) => formatActivityEvent(event, (userId) => playerNames.get(userId) ?? userId))
    .filter((event): event is RoomActivityItem => event !== null)
    .slice(0, 12);
}

async function loadRoomMetadata(db: D1Database, roomId: string): Promise<RoomMetadataRow | null> {
  return db
    .prepare(
      `SELECT
        id,
        code,
        name,
        host_user_id AS hostUserId,
        status,
        active_game_id AS activeGameId
      FROM rooms
      WHERE id = ?`
    )
    .bind(roomId)
    .first<RoomMetadataRow>();
}

async function loadRoomMembers(db: D1Database, roomId: string): Promise<MemberRow[]> {
  const result = await db
    .prepare(
      `SELECT
        room_members.user_id AS userId,
        users.display_name AS displayName,
        room_members.seat_index AS seatIndex,
        room_members.is_host AS isHost
      FROM room_members
      INNER JOIN users ON users.id = room_members.user_id
      WHERE room_members.room_id = ?
      ORDER BY room_members.seat_index ASC, room_members.joined_at ASC`
    )
    .bind(roomId)
    .all<MemberRow>();

  return result.results ?? [];
}

async function loadRoomSpectators(db: D1Database, roomId: string): Promise<SpectatorRow[]> {
  const result = await db
    .prepare(
      `SELECT
        room_spectators.user_id AS userId,
        users.display_name AS displayName
      FROM room_spectators
      INNER JOIN users ON users.id = room_spectators.user_id
      WHERE room_spectators.room_id = ?
      ORDER BY room_spectators.joined_at ASC`
    )
    .bind(roomId)
    .all<SpectatorRow>();

  return result.results ?? [];
}

export async function loadRoomPresenceState(
  db: D1Database,
  roomId: string,
  connectedUserIds: Set<string>
): Promise<RoomPresenceState | null> {
  const [room, members, spectators] = await Promise.all([
    loadRoomMetadata(db, roomId),
    loadRoomMembers(db, roomId),
    loadRoomSpectators(db, roomId)
  ]);

  if (!room) {
    return null;
  }

  const activeGame = room.activeGameId ? await loadActiveGameView(db, room.activeGameId) : null;

  const players: PlayerPresence[] = members.map((member) => ({
    connected: connectedUserIds.has(member.userId),
    displayName: member.displayName,
    role: member.isHost === 1 ? "host" : "player",
    userId: member.userId
  }));

  const seats: RoomSeat[] = members
    .filter((member) => member.seatIndex !== null)
    .map((member) => ({
      connected: connectedUserIds.has(member.userId),
      displayName: member.displayName,
      seat: Number(member.seatIndex),
      userId: member.userId
    }));

  return {
    activeGame,
    lockStatus: roomVisibility(room.status),
    players,
    room: {
      code: room.code,
      hostId: room.hostUserId,
      id: room.id,
      name: room.name,
      visibility: roomVisibility(room.status)
    },
    seats,
    spectators: spectators.map((spectator) => ({
      connected: connectedUserIds.has(spectator.userId),
      displayName: spectator.displayName,
      role: "spectator",
      userId: spectator.userId
    }))
  };
}

export async function loadRoomSnapshotPayload(
  db: D1Database,
  roomId: string,
  connectedUserIds: Set<string>,
  viewerUserId: string
): Promise<RoomSnapshotEventPayload | null> {
  const state = await loadRoomPresenceState(db, roomId, connectedUserIds);
  if (!state) {
    return null;
  }

  const viewerRole = await loadRoomViewerRole(db, roomId, viewerUserId);
  const viewerSecretState =
    state.activeGame && viewerRole
      ? await loadViewerSecretState(db, state.activeGame.id, viewerUserId, viewerRole)
      : null;
  const activeGameState = state.activeGame ? await loadActiveGameState(db, state.activeGame.id) : null;
  const activityLog =
    state.activeGame && viewerRole ? await loadRecentActivityLog(db, state.activeGame.id, viewerUserId, viewerRole) : [];

  return {
    activeGame: state.activeGame,
    activityLog,
    lockStatus: state.lockStatus,
    players: state.players,
    room: state.room,
    seats: state.seats,
    spectators: state.spectators,
    viewerActionState:
      viewerRole === "member" && activeGameState
        ? {
            questVoteSubmitted: Boolean(activeGameState.questVotes?.[viewerUserId]),
            teamVoteSubmitted: Boolean(activeGameState.teamVotes?.[viewerUserId])
          }
        : null,
    viewerSecretState
  };
}
