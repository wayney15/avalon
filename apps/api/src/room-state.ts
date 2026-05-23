import type {
  ActiveGameView,
  PlayerPresence,
  RoomIdentity,
  RoomSeat,
  RoomSnapshotEventPayload,
  RoomVisibility,
  SpectatorPresence
} from "../../../packages/shared/src";
import { loadActiveGameView, loadRoomViewerRole, loadViewerSecretState } from "./rooms";

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

  return {
    activeGame: state.activeGame,
    lockStatus: state.lockStatus,
    players: state.players,
    room: state.room,
    seats: state.seats,
    spectators: state.spectators,
    viewerSecretState
  };
}
