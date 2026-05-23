import type {
  ActiveGameView,
  AuthUser,
  QuestVote,
  Role,
  RoomSummary,
  Team,
  TeamVote,
  ViewerSecretState
} from "../../../packages/shared/src";
import { buildViewerSecretState, missionTeamSize } from "./game-rules";

export interface RoomRow {
  id: string;
  code: string;
  inviteToken: string;
  name: string;
  hostUserId: string;
  status: "open" | "locked" | "archived";
  activeGameId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RoomCountRow {
  playerCount: number;
  spectatorCount: number;
}

interface ExistingMemberRow {
  isHost: number;
  seatIndex: number | null;
}

interface SeatMemberRow {
  userId: string;
  seatIndex: number | null;
}

interface RoomMemberRosterRow {
  userId: string;
  displayName: string;
  seatIndex: number;
  isHost: number;
}

interface ActiveGameRow {
  id: string;
  status: "in_progress" | "finished" | "unfinished";
  playerCount: number;
  missionWinsGood: number;
  missionWinsEvil: number;
}

interface ActiveGameStateEventRow {
  payloadJson: string;
}

interface MissionResultEventRow {
  payloadJson: string;
}

export interface PersistedGameState {
  status: "night" | "proposal" | "team-vote" | "quest-vote" | "assassination" | "finished" | "unfinished";
  round: number;
  attempt: number;
  leaderUserId: string;
  rejectTracker: number;
  disconnectedUserIds?: string[];
  revealedDisconnectedUserIds?: string[];
  teamUserIds?: string[];
  teamVotes?: Record<string, TeamVote>;
  questVotes?: Record<string, QuestVote>;
  assassination?: {
    assassinUserId: string;
    candidateUserIds: string[];
  };
}

interface ActiveGamePlayerRow {
  userId: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  team: Team;
  isHost?: number;
}

interface SequenceRow {
  nextSequenceNo: number;
}

interface StartGameOptions {
  roomId: string;
  hostUserId: string;
  playerCount: number;
  leaderUserId: string;
  assignments: Array<{
    userId: string;
    displayName: string;
    seatIndex: number;
    role: Role;
    team: Team;
    isHost: boolean;
  }>;
}

interface StartedGameStatePayload {
  gameId: string;
  status: "night";
  round: number;
  attempt: number;
  leaderUserId: string;
  rejectTracker: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function roomVisibility(status: RoomRow["status"]): "open" | "locked" {
  return status === "open" ? "open" : "locked";
}

function toRoomSummary(room: RoomRow, counts: RoomCountRow): RoomSummary {
  return {
    code: room.code,
    hasActiveGame: room.activeGameId !== null,
    hostId: room.hostUserId,
    id: room.id,
    name: room.name,
    playerCount: counts.playerCount,
    spectatorCount: counts.spectatorCount,
    visibility: roomVisibility(room.status)
  };
}

export async function loadRoomRow(db: D1Database, roomId: string): Promise<RoomRow | null> {
  return db
    .prepare(
      `SELECT
        id,
        code,
        invite_token AS inviteToken,
        name,
        host_user_id AS hostUserId,
        status,
        active_game_id AS activeGameId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM rooms
      WHERE id = ?`
    )
    .bind(roomId)
    .first<RoomRow>();
}

export async function loadRoomByCode(db: D1Database, roomCode: string): Promise<RoomRow | null> {
  return db
    .prepare(
      `SELECT
        id,
        code,
        invite_token AS inviteToken,
        name,
        host_user_id AS hostUserId,
        status,
        active_game_id AS activeGameId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM rooms
      WHERE code = ?`
    )
    .bind(roomCode)
    .first<RoomRow>();
}

export async function loadRoomByInviteToken(db: D1Database, inviteToken: string): Promise<RoomRow | null> {
  return db
    .prepare(
      `SELECT
        id,
        code,
        invite_token AS inviteToken,
        name,
        host_user_id AS hostUserId,
        status,
        active_game_id AS activeGameId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM rooms
      WHERE invite_token = ?`
    )
    .bind(inviteToken)
    .first<RoomRow>();
}

export async function loadRoomCounts(db: D1Database, roomId: string): Promise<RoomCountRow> {
  const counts = await db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM room_members WHERE room_id = ?) AS playerCount,
        (SELECT COUNT(*) FROM room_spectators WHERE room_id = ?) AS spectatorCount`
    )
    .bind(roomId, roomId)
    .first<RoomCountRow>();

  return {
    playerCount: Number(counts?.playerCount ?? 0),
    spectatorCount: Number(counts?.spectatorCount ?? 0)
  };
}

export async function loadRoomSummary(db: D1Database, roomId: string): Promise<RoomSummary | null> {
  const room = await loadRoomRow(db, roomId);
  if (!room) {
    return null;
  }

  return toRoomSummary(room, await loadRoomCounts(db, roomId));
}

export async function loadRecentRoomSummary(db: D1Database, userId: string): Promise<RoomSummary | null> {
  const recent = await db
    .prepare(
      `SELECT roomId
      FROM (
        SELECT roomId, MAX(activityAt) AS activityAt
        FROM (
          SELECT room_id AS roomId, last_seen_at AS activityAt
          FROM room_members
          WHERE user_id = ?

          UNION ALL

          SELECT room_id AS roomId, last_seen_at AS activityAt
          FROM room_spectators
          WHERE user_id = ?

          UNION ALL

          SELECT games.room_id AS roomId, COALESCE(games.ended_at, games.started_at) AS activityAt
          FROM games
          INNER JOIN game_players ON game_players.game_id = games.id
          WHERE game_players.user_id = ?
        )
        GROUP BY roomId
      )
      ORDER BY activityAt DESC
      LIMIT 1`
    )
    .bind(userId, userId, userId)
    .first<{ roomId: string }>();

  if (!recent?.roomId) {
    return null;
  }

  return loadRoomSummary(db, recent.roomId);
}

export async function loadRoomViewerRole(
  db: D1Database,
  roomId: string,
  userId: string
): Promise<"member" | "spectator" | null> {
  const row = await db
    .prepare(
      `SELECT
        CASE
          WHEN EXISTS(SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?) THEN 'member'
          WHEN EXISTS(SELECT 1 FROM room_spectators WHERE room_id = ? AND user_id = ?) THEN 'spectator'
          ELSE NULL
        END AS role`
    )
    .bind(roomId, userId, roomId, userId)
    .first<{ role: "member" | "spectator" | null }>();

  return row?.role ?? null;
}

export async function loadRoomAccess(db: D1Database, roomId: string, userId: string): Promise<boolean> {
  return (await loadRoomViewerRole(db, roomId, userId)) !== null;
}

export async function loadRoomHistoryAccess(db: D1Database, roomId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT
        CASE
          WHEN EXISTS(SELECT 1 FROM room_members WHERE room_id = ? AND user_id = ?) THEN 1
          WHEN EXISTS(SELECT 1 FROM room_spectators WHERE room_id = ? AND user_id = ?) THEN 1
          WHEN EXISTS(
            SELECT 1
            FROM games
            INNER JOIN game_players ON game_players.game_id = games.id
            WHERE games.room_id = ? AND game_players.user_id = ?
          ) THEN 1
          ELSE 0
        END AS allowed`
    )
    .bind(roomId, userId, roomId, userId, roomId, userId)
    .first<{ allowed: number }>();

  return Number(row?.allowed ?? 0) === 1;
}

export async function loadRoomMemberRoster(db: D1Database, roomId: string): Promise<RoomMemberRosterRow[]> {
  const result = await db
    .prepare(
      `SELECT
        room_members.user_id AS userId,
        users.display_name AS displayName,
        room_members.seat_index AS seatIndex,
        room_members.is_host AS isHost
      FROM room_members
      INNER JOIN users ON users.id = room_members.user_id
      WHERE room_members.room_id = ? AND room_members.seat_index IS NOT NULL
      ORDER BY room_members.seat_index ASC, room_members.joined_at ASC`
    )
    .bind(roomId)
    .all<RoomMemberRosterRow>();

  return result.results ?? [];
}

export async function updateRoomTimestamp(db: D1Database, roomId: string): Promise<void> {
  await db
    .prepare("UPDATE rooms SET updated_at = ? WHERE id = ?")
    .bind(nowIso(), roomId)
    .run();
}

export async function upsertRoomMember(db: D1Database, room: RoomRow, user: AuthUser): Promise<void> {
  const timestamp = nowIso();
  const existing = await db
    .prepare(
      "SELECT seat_index AS seatIndex, is_host AS isHost FROM room_members WHERE room_id = ? AND user_id = ?"
    )
    .bind(room.id, user.id)
    .first<ExistingMemberRow>();

  const seatIndex =
    existing?.seatIndex ?? (await db
      .prepare("SELECT COALESCE(MAX(seat_index), -1) + 1 AS nextSeatIndex FROM room_members WHERE room_id = ?")
      .bind(room.id)
      .first<{ nextSeatIndex: number }>())
      ?.nextSeatIndex ?? 0;

  const isHost = room.hostUserId === user.id || Number(existing?.isHost ?? 0) === 1 ? 1 : 0;

  await db
    .prepare(
      `INSERT INTO room_members (
        room_id, user_id, seat_index, joined_at, last_seen_at, is_host
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id, user_id) DO UPDATE SET
        seat_index = COALESCE(room_members.seat_index, excluded.seat_index),
        last_seen_at = excluded.last_seen_at,
        is_host = CASE
          WHEN room_members.is_host = 1 OR excluded.is_host = 1 THEN 1
          ELSE 0
        END`
    )
    .bind(room.id, user.id, seatIndex, timestamp, timestamp, isHost)
    .run();

  if (isHost === 0) {
    await db.prepare("DELETE FROM room_spectators WHERE room_id = ? AND user_id = ?").bind(room.id, user.id).run();
  }
}

export async function upsertRoomSpectator(db: D1Database, room: RoomRow, user: AuthUser): Promise<void> {
  const timestamp = nowIso();

  await db
    .prepare(
      `INSERT INTO room_spectators (
        room_id, user_id, joined_at, last_seen_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(room_id, user_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at`
    )
    .bind(room.id, user.id, timestamp, timestamp)
    .run();

  if (room.hostUserId !== user.id) {
    await db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").bind(room.id, user.id).run();
  }
}

export async function transferRoomHost(db: D1Database, roomId: string, nextHostUserId: string): Promise<void> {
  const timestamp = nowIso();

  await db.batch([
    db
      .prepare("UPDATE rooms SET host_user_id = ?, updated_at = ? WHERE id = ?")
      .bind(nextHostUserId, timestamp, roomId),
    db.prepare("UPDATE room_members SET is_host = 0 WHERE room_id = ?").bind(roomId),
    db.prepare("UPDATE room_members SET is_host = 1 WHERE room_id = ? AND user_id = ?").bind(roomId, nextHostUserId)
  ]);
}

export async function removeRoomParticipant(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?").bind(roomId, userId),
    db.prepare("DELETE FROM room_spectators WHERE room_id = ? AND user_id = ?").bind(roomId, userId),
    db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(nowIso(), roomId)
  ]);
}

export async function removeRoomSpectator(db: D1Database, roomId: string, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM room_spectators WHERE room_id = ? AND user_id = ?").bind(roomId, userId),
    db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(nowIso(), roomId)
  ]);
}

function randomId(prefix: string, byteLength = 12): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "")}`;
}

export async function createStartedGame(db: D1Database, options: StartGameOptions): Promise<{ gameId: string }> {
  const timestamp = nowIso();
  const gameId = randomId("game_");
  const startedState: StartedGameStatePayload = {
    attempt: 1,
    gameId,
    leaderUserId: options.leaderUserId,
    rejectTracker: 0,
    round: 1,
    status: "night"
  };

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO games (
          id, room_id, status, player_count, host_user_id, started_at, ended_at, ended_reason, winner, mission_wins_good, mission_wins_evil
        ) VALUES (?, ?, 'in_progress', ?, ?, ?, NULL, NULL, NULL, 0, 0)`
      )
      .bind(gameId, options.roomId, options.playerCount, options.hostUserId, timestamp),
    db
      .prepare("UPDATE rooms SET status = 'locked', active_game_id = ?, updated_at = ? WHERE id = ?")
      .bind(gameId, timestamp, options.roomId),
    db
      .prepare(
        `INSERT INTO game_events (
          id, game_id, sequence_no, event_type, actor_user_id, visible_to, subject_user_id, payload_json, created_at
        ) VALUES (?, ?, 1, 'game.started', ?, 'all', NULL, ?, ?)`
      )
      .bind(randomId("gev_"), gameId, options.hostUserId, JSON.stringify(startedState), timestamp),
    db
      .prepare(
        `INSERT INTO game_events (
          id, game_id, sequence_no, event_type, actor_user_id, visible_to, subject_user_id, payload_json, created_at
        ) VALUES (?, ?, 2, 'game.phase.changed', ?, 'all', NULL, ?, ?)`
      )
      .bind(
        randomId("gev_"),
        gameId,
        options.hostUserId,
        JSON.stringify({
          attempt: 1,
          gameId,
          leaderUserId: options.leaderUserId,
          phase: "night",
          round: 1
        }),
        timestamp
      )
  ];

  for (const assignment of options.assignments) {
    statements.push(
      db
        .prepare(
          `INSERT INTO game_players (
            game_id, user_id, display_name_snapshot, seat_index, role, team, is_host, final_outcome
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'unfinished')`
        )
        .bind(
          gameId,
          assignment.userId,
          assignment.displayName,
          assignment.seatIndex,
          assignment.role,
          assignment.team,
          assignment.isHost ? 1 : 0
        )
    );
  }

  await db.batch(statements);
  return { gameId };
}

export async function appendGameEvent(db: D1Database, options: {
  gameId: string;
  eventType: string;
  actorUserId: string | null;
  visibleTo: "all" | "host" | "evil" | "good" | "self" | "spectators" | "system";
  subjectUserId?: string | null;
  payload: unknown;
}): Promise<number> {
  const nextSequence =
    (await db
      .prepare("SELECT COALESCE(MAX(sequence_no), 0) + 1 AS nextSequenceNo FROM game_events WHERE game_id = ?")
      .bind(options.gameId)
      .first<SequenceRow>())?.nextSequenceNo ?? 1;

  await db
    .prepare(
      `INSERT INTO game_events (
        id, game_id, sequence_no, event_type, actor_user_id, visible_to, subject_user_id, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      randomId("gev_"),
      options.gameId,
      nextSequence,
      options.eventType,
      options.actorUserId,
      options.visibleTo,
      options.subjectUserId ?? null,
      JSON.stringify(options.payload),
      nowIso()
    )
    .run();

  return nextSequence;
}

export async function persistGameState(
  db: D1Database,
  gameId: string,
  actorUserId: string | null,
  state: PersistedGameState
): Promise<void> {
  await appendGameEvent(db, {
    actorUserId,
    eventType: "game.state.updated",
    gameId,
    payload: state,
    subjectUserId: "__system__",
    visibleTo: "self"
  });
}

export async function loadActiveGameState(db: D1Database, gameId: string): Promise<PersistedGameState | null> {
  const event = await db
    .prepare(
      `SELECT payload_json AS payloadJson
      FROM game_events
      WHERE game_id = ? AND event_type IN ('game.state.updated', 'game.started')
      ORDER BY sequence_no DESC
      LIMIT 1`
    )
    .bind(gameId)
    .first<ActiveGameStateEventRow>();

  if (!event) {
    return null;
  }

  return JSON.parse(event.payloadJson) as PersistedGameState;
}

export async function loadActiveGameView(db: D1Database, activeGameId: string): Promise<ActiveGameView | null> {
  const [game, state, missionResultEvents] = await Promise.all([
    db
      .prepare(
        `SELECT
          id,
          status,
          player_count AS playerCount,
          mission_wins_good AS missionWinsGood,
          mission_wins_evil AS missionWinsEvil
        FROM games
        WHERE id = ?`
      )
      .bind(activeGameId)
      .first<ActiveGameRow>(),
    loadActiveGameState(db, activeGameId),
    db
      .prepare(
        `SELECT payload_json AS payloadJson
        FROM game_events
        WHERE game_id = ? AND event_type = 'quest.result.revealed'
        ORDER BY sequence_no ASC`
      )
      .bind(activeGameId)
      .all<MissionResultEventRow>()
  ]);

  if (!game || !state) {
    return null;
  }

  const roster = state.status === "team-vote" ? await loadGamePlayerRoster(db, activeGameId) : [];
  const submittedVotes = new Set(Object.keys(state.teamVotes ?? {}));
  const missionResults = (missionResultEvents.results ?? []).map((event) => {
    const payload = JSON.parse(event.payloadJson) as { winner: Team };
    return payload.winner === "good" ? "success" : "fail";
  });

  return {
    assassination: state.assassination ?? null,
    attempt: state.attempt,
    id: game.id,
    leaderUserId: state.leaderUserId,
    missionScores: {
      evil: game.missionWinsEvil,
      good: game.missionWinsGood
    },
    missionResults,
    missionSize: state.status === "assassination" ? null : missionTeamSize(game.playerCount, state.round),
    proposedTeamUserIds: state.status === "assassination" ? null : state.teamUserIds ?? null,
    rejectTracker: state.rejectTracker,
    round: state.round,
    status: game.status === "in_progress" ? state.status : game.status,
    teamVotesSubmitted: state.status === "team-vote" ? submittedVotes.size : null,
    pendingTeamVoteUserIds:
      state.status === "team-vote"
        ? roster.filter((player) => !submittedVotes.has(player.userId)).map((player) => player.userId)
        : null
  };
}

export async function loadGamePlayerRoster(db: D1Database, gameId: string): Promise<ActiveGamePlayerRow[]> {
  const result = await db
    .prepare(
      `SELECT
        user_id AS userId,
        display_name_snapshot AS displayName,
        seat_index AS seatIndex,
        role,
        team,
        is_host AS isHost
      FROM game_players
      WHERE game_id = ?
      ORDER BY seat_index ASC`
    )
    .bind(gameId)
    .all<ActiveGamePlayerRow>();

  return result.results ?? [];
}

export async function loadViewerSecretState(
  db: D1Database,
  activeGameId: string,
  viewerUserId: string,
  viewerRole: "member" | "spectator"
): Promise<ViewerSecretState | null> {
  const [state, roster] = await Promise.all([
    loadActiveGameState(db, activeGameId),
    loadGamePlayerRoster(db, activeGameId)
  ]);

  return buildViewerSecretState(
    viewerUserId,
    viewerRole,
    roster,
    state?.revealedDisconnectedUserIds ?? []
  );
}

export async function finalizeGame(
  db: D1Database,
  options: {
    gameId: string;
    roomId: string;
    winner: Team | null;
    status: "finished" | "unfinished";
    endedReason: "five_rejections" | "good_win" | "evil_win" | "assassination" | "forced_termination" | "host_ended_game";
    finalOutcome: "good_win" | "evil_win" | "unfinished";
  }
): Promise<void> {
  const timestamp = nowIso();

  await db.batch([
    db
      .prepare(
        `UPDATE games
        SET status = ?, ended_at = ?, ended_reason = ?, winner = ?
        WHERE id = ?`
      )
      .bind(options.status, timestamp, options.endedReason, options.winner, options.gameId),
    db
      .prepare("UPDATE game_players SET final_outcome = ? WHERE game_id = ?")
      .bind(options.finalOutcome, options.gameId),
    db
      .prepare("UPDATE rooms SET status = 'open', active_game_id = NULL, updated_at = ? WHERE id = ?")
      .bind(timestamp, options.roomId)
  ]);
}

export async function updateGameScore(
  db: D1Database,
  gameId: string,
  score: { good: number; evil: number }
): Promise<void> {
  await db
    .prepare(
      `UPDATE games
      SET mission_wins_good = ?, mission_wins_evil = ?
      WHERE id = ?`
    )
    .bind(score.good, score.evil, gameId)
    .run();
}

export async function swapRoomSeats(
  db: D1Database,
  roomId: string,
  leftSeat: number,
  rightSeat: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT
        user_id AS userId,
        seat_index AS seatIndex
      FROM room_members
      WHERE room_id = ? AND seat_index IN (?, ?)`
    )
    .bind(roomId, leftSeat, rightSeat)
    .all<SeatMemberRow>();

  const members = result.results ?? [];
  const left = members.find((member) => member.seatIndex === leftSeat);
  const right = members.find((member) => member.seatIndex === rightSeat);

  if (!left || !right) {
    return false;
  }

  await db.batch([
    db.prepare("UPDATE room_members SET seat_index = ? WHERE room_id = ? AND user_id = ?").bind(rightSeat, roomId, left.userId),
    db.prepare("UPDATE room_members SET seat_index = ? WHERE room_id = ? AND user_id = ?").bind(leftSeat, roomId, right.userId),
    db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(nowIso(), roomId)
  ]);

  return true;
}

export async function randomizeRoomSeats(db: D1Database, roomId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `SELECT
        user_id AS userId,
        seat_index AS seatIndex
      FROM room_members
      WHERE room_id = ?
      ORDER BY seat_index ASC, joined_at ASC`
    )
    .bind(roomId)
    .all<SeatMemberRow>();

  const members = (result.results ?? []).filter(
    (member): member is { userId: string; seatIndex: number } => member.seatIndex !== null
  );

  if (members.length < 2) {
    return false;
  }

  const seatOrder = [...members.map((member) => member.seatIndex)];
  for (let index = seatOrder.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [seatOrder[index], seatOrder[swapIndex]] = [seatOrder[swapIndex], seatOrder[index]];
  }

  const updates = members.map((member, index) =>
    db.prepare("UPDATE room_members SET seat_index = ? WHERE room_id = ? AND user_id = ?").bind(seatOrder[index], roomId, member.userId)
  );
  updates.push(db.prepare("UPDATE rooms SET updated_at = ? WHERE id = ?").bind(nowIso(), roomId));

  await db.batch(updates);
  return true;
}
