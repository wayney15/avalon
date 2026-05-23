import { Hono } from "hono";
import { cors } from "hono/cors";
import type {
  ApiHealth,
  AuthSession,
  AuthUser,
  CreateRoomRequest,
  CreateRoomResponse,
  GameReplayResponse,
  ReplayPlayerSummary,
  GameSummary,
  JoinRoomRequest,
  JoinRoomResponse,
  RecentRoomResponse,
  ReplayEvent,
  RoomDetailResponse,
  RoomHistoryResponse,
  RoomSummary,
  UserHistoryGameSummary,
  UserHistoryResponse
} from "../../../packages/shared/src";
import { authError, validateLoginInput, validateSignupInput } from "./auth";
import type { AppVariables, Env } from "./context";
import { authenticate } from "./middleware/authenticate";
import { hashPassword, verifyPassword } from "./passwords";
import { signJwt } from "./jwt";
import {
  loadRoomAccess,
  loadRoomByCode,
  loadRoomByInviteToken,
  loadGamePlayerRoster,
  loadRoomHistoryAccess,
  loadRecentRoomSummary,
  loadRoomRow,
  loadRoomSummary,
  loadRoomViewerRole,
  type RoomRow,
  roomVisibility,
  updateRoomTimestamp,
  upsertRoomMember,
  upsertRoomSpectator
} from "./rooms";
export { RoomCoordinator } from "./room-coordinator";

interface UserRow extends AuthUser {
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

interface GamePlayerRow {
  userId: string;
  team: "good" | "evil";
  isHost: number;
}

interface GameEventRow {
  id: string;
  gameId: string;
  sequenceNo: number;
  eventType: string;
  actorUserId: string | null;
  visibleTo: ReplayEvent["visibleTo"];
  subjectUserId: string | null;
  payloadJson: string;
  createdAt: string;
}

const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_ID_BYTES = 12;

function nowIso(): string {
  return new Date().toISOString();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function randomId(prefix: string, byteLength = ROOM_ID_BYTES): string {
  return `${prefix}${encodeBase64Url(crypto.getRandomValues(new Uint8Array(byteLength)))}`;
}

function generateRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join("");
}

function inviteBaseUrl(request: Request): URL {
  const requestUrl = new URL(request.url);
  const originHeader = request.headers.get("Origin")?.trim();

  if (!originHeader) {
    return requestUrl;
  }

  try {
    return new URL(originHeader);
  } catch {
    return requestUrl;
  }
}

function inviteUrlForToken(request: Request, inviteToken: string): string {
  return new URL(`/rooms/invite/${inviteToken}`, inviteBaseUrl(request)).toString();
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed|constraint failed/i.test(error.message);
}

async function loadUserByNormalizedUsername(db: D1Database, username: string): Promise<UserRow | null> {
  return db
    .prepare(
      `SELECT
        id,
        username,
        display_name AS displayName,
        password_hash AS passwordHash,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM users
      WHERE username = ?`
    )
    .bind(username)
    .first<UserRow>();
}

async function loadGameSummary(db: D1Database, gameId: string): Promise<GameSummary | null> {
  return db
    .prepare(
      `SELECT
        id,
        room_id AS roomId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        winner
      FROM games
      WHERE id = ?`
    )
    .bind(gameId)
    .first<GameSummary>();
}

async function loadGamePlayer(db: D1Database, gameId: string, userId: string): Promise<GamePlayerRow | null> {
  return db
    .prepare(
      `SELECT
        user_id AS userId,
        team,
        is_host AS isHost
      FROM game_players
      WHERE game_id = ? AND user_id = ?`
    )
    .bind(gameId, userId)
    .first<GamePlayerRow>();
}

async function loadGameEvents(db: D1Database, gameId: string): Promise<ReplayEvent[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        game_id AS gameId,
        sequence_no AS sequenceNo,
        event_type AS eventType,
        actor_user_id AS actorUserId,
        visible_to AS visibleTo,
        subject_user_id AS subjectUserId,
        payload_json AS payloadJson,
        created_at AS createdAt
      FROM game_events
      WHERE game_id = ?
      ORDER BY sequence_no ASC`
    )
    .bind(gameId)
    .all<GameEventRow>();

  return (result.results ?? []).map((event) => ({
    actorUserId: event.actorUserId,
    createdAt: event.createdAt,
    eventType: event.eventType,
    gameId: event.gameId,
    id: event.id,
    payload: JSON.parse(event.payloadJson) as unknown,
    sequenceNo: event.sequenceNo,
    subjectUserId: event.subjectUserId,
    visibleTo: event.visibleTo
  }));
}

function canViewReplayEvent(
  event: ReplayEvent,
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

async function loadRoomGames(db: D1Database, roomId: string): Promise<GameSummary[]> {
  const result = await db
    .prepare(
      `SELECT
        id,
        room_id AS roomId,
        status,
        started_at AS startedAt,
        ended_at AS endedAt,
        winner
      FROM games
      WHERE room_id = ?
      ORDER BY started_at DESC`
    )
    .bind(roomId)
    .all<GameSummary>();

  return result.results ?? [];
}

async function loadUserFinishedGames(db: D1Database, userId: string): Promise<UserHistoryGameSummary[]> {
  const result = await db
    .prepare(
      `SELECT
        games.id AS id,
        games.room_id AS roomId,
        games.status AS status,
        games.started_at AS startedAt,
        games.ended_at AS endedAt,
        games.winner AS winner,
        rooms.code AS roomCode,
        rooms.name AS roomName
      FROM games
      INNER JOIN game_players ON game_players.game_id = games.id
      INNER JOIN rooms ON rooms.id = games.room_id
      WHERE game_players.user_id = ? AND games.status = 'finished'
      ORDER BY games.ended_at DESC, games.started_at DESC`
    )
    .bind(userId)
    .all<UserHistoryGameSummary>();

  return result.results ?? [];
}

async function createRoomRecord(
  db: D1Database,
  owner: AuthUser,
  name: string
): Promise<{ room: RoomRow; inviteToken: string }> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const roomId = randomId("room_");
    const roomCode = generateRoomCode();
    const inviteToken = randomId("inv_", 16);
    const timestamp = nowIso();

    try {
      await db.batch([
        db
          .prepare(
            `INSERT INTO rooms (
              id, code, invite_token, name, host_user_id, status, active_game_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)`
          )
          .bind(roomId, roomCode, inviteToken, name, owner.id, timestamp, timestamp),
        db
          .prepare(
            `INSERT INTO room_members (
              room_id, user_id, seat_index, joined_at, last_seen_at, is_host
            ) VALUES (?, ?, 0, ?, ?, 1)`
          )
          .bind(roomId, owner.id, timestamp, timestamp)
      ]);

      const room = await loadRoomRow(db, roomId);
      if (!room) {
        throw new Error("Room insert failed unexpectedly.");
      }

      return { inviteToken, room };
    } catch (error) {
      if (isUniqueConstraintError(error) && attempt < 7) {
        continue;
      }

      throw error;
    }
  }

  throw new Error("Unable to generate a unique room code.");
}

async function createUserAndSession(
  env: Env,
  normalizedUsername: string,
  displayName: string,
  password: string
): Promise<AuthSession> {
  const existing = await loadUserByNormalizedUsername(env.DB, normalizedUsername);
  if (existing) {
    throw new Response(JSON.stringify(authError("username_taken", "That username is already in use.")), {
      status: 409
    });
  }

  const timestamp = nowIso();
  const userId = randomId("usr_");
  const passwordHash = await hashPassword(password);

  try {
    await env.DB
      .prepare(
        `INSERT INTO users (
          id, username, display_name, password_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(userId, normalizedUsername, displayName, passwordHash, timestamp, timestamp)
      .run();
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new Response(JSON.stringify(authError("username_taken", "That username is already in use.")), {
        status: 409
      });
    }

    throw error;
  }

  return {
    token: await signJwt(
      {
        displayName,
        sub: userId,
        username: normalizedUsername
      },
      {
        issuer: env.JWT_ISSUER,
        secret: env.JWT_SECRET
      }
    ),
    user: {
      displayName,
      id: userId,
      username: normalizedUsername
    }
  };
}

const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

app.use("/*", cors());
app.use("/api/auth/me", authenticate);
app.use("/api/rooms", authenticate);
app.use("/api/rooms/*", authenticate);
app.use("/api/games", authenticate);
app.use("/api/games/*", authenticate);
app.use("/api/history", authenticate);
app.use("/api/history/*", authenticate);

app.get("/api/health", (c) => {
  const body: ApiHealth = {
    ok: true,
    service: "avalon-api"
  };

  return c.json(body);
});

app.post("/api/auth/signup", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = validateSignupInput(body);

  if (!parsed.ok) {
    return c.json(authError("invalid_request", parsed.message), 400);
  }

  if (!c.env.JWT_SECRET) {
    return c.json(authError("server_misconfigured", "JWT signing is not configured."), 500);
  }

  try {
    const session = await createUserAndSession(c.env, parsed.value.username, parsed.value.displayName, parsed.value.password);
    return c.json(session, 201);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    throw error;
  }
});

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = validateLoginInput(body);

  if (!parsed.ok) {
    return c.json(authError("invalid_request", parsed.message), 400);
  }

  if (!c.env.JWT_SECRET) {
    return c.json(authError("server_misconfigured", "JWT signing is not configured."), 500);
  }

  const user = await loadUserByNormalizedUsername(c.env.DB, parsed.value.username);
  if (!user) {
    return c.json(authError("invalid_credentials", "Invalid username or password."), 401);
  }

  const validPassword = await verifyPassword(parsed.value.password, user.passwordHash);
  if (!validPassword) {
    return c.json(authError("invalid_credentials", "Invalid username or password."), 401);
  }

  const session: AuthSession = {
    token: await signJwt(
      {
        displayName: user.displayName,
        sub: user.id,
        username: user.username
      },
      {
        issuer: c.env.JWT_ISSUER,
        secret: c.env.JWT_SECRET
      }
    ),
    user: {
      displayName: user.displayName,
      id: user.id,
      username: user.username
    }
  };

  return c.json(session);
});

app.get("/api/auth/me", async (c) => c.json({ user: c.get("authUser") }));

app.post("/api/rooms", async (c) => {
  const body = await c.req.json().catch(() => null);
  const payload = body as CreateRoomRequest | null;

  if (!payload || typeof payload.name !== "string") {
    return c.json(authError("invalid_request", "Room name is required."), 400);
  }

  const name = payload.name.trim();
  if (name.length === 0 || name.length > 80) {
    return c.json(authError("invalid_request", "Room name must be between 1 and 80 characters."), 400);
  }

  const sessionUser = c.get("authUser");
  const { inviteToken, room } = await createRoomRecord(c.env.DB, sessionUser, name);
  const summary = await loadRoomSummary(c.env.DB, room.id);

  if (!summary) {
    return c.json(authError("room_creation_failed", "The room could not be created."), 500);
  }

  const response: CreateRoomResponse = {
    inviteUrl: inviteUrlForToken(c.req.raw, inviteToken),
    room: summary
  };

  return c.json(response, 201);
});

app.post("/api/rooms/join", async (c) => {
  const body = await c.req.json().catch(() => null);
  const payload = body as JoinRoomRequest | null;

  if (!payload) {
    return c.json(authError("invalid_request", "A room code or invite token is required."), 400);
  }

  const roomCode = typeof payload.roomCode === "string" ? payload.roomCode.trim().toUpperCase() : "";
  const inviteToken = typeof payload.inviteToken === "string" ? payload.inviteToken.trim() : "";

  if (roomCode.length === 0 && inviteToken.length === 0) {
    return c.json(authError("invalid_request", "A room code or invite token is required."), 400);
  }

  const room =
    roomCode.length > 0 ? await loadRoomByCode(c.env.DB, roomCode) : await loadRoomByInviteToken(c.env.DB, inviteToken);
  if (!room) {
    return c.json(authError("room_not_found", "That room does not exist."), 404);
  }

  if (room.status !== "open") {
    return c.json(authError("room_locked", "This room is locked while a game is in progress."), 409);
  }

  const user = c.get("authUser");
  const wantsSpectator = payload.asSpectator === true;

  if (wantsSpectator && room.hostUserId === user.id) {
    return c.json(authError("invalid_request", "The host must remain a player in the room."), 400);
  }

  if (wantsSpectator) {
    await upsertRoomSpectator(c.env.DB, room, user);
  } else {
    await upsertRoomMember(c.env.DB, room, user);
  }

  await updateRoomTimestamp(c.env.DB, room.id);
  const summary = await loadRoomSummary(c.env.DB, room.id);

  if (!summary) {
    return c.json(authError("room_join_failed", "The room could not be joined."), 500);
  }

  const response: JoinRoomResponse = {
    room: summary
  };

  return c.json(response);
});

app.get("/api/rooms/recent", async (c) => {
  const user = c.get("authUser");
  const room = await loadRecentRoomSummary(c.env.DB, user.id);
  const response: RecentRoomResponse = { room };
  return c.json(response);
});

app.get("/api/rooms/:roomId", async (c) => {
  const roomId = c.req.param("roomId");
  const user = c.get("authUser");
  const [room, summary] = await Promise.all([loadRoomRow(c.env.DB, roomId), loadRoomSummary(c.env.DB, roomId)]);

  if (!room || !summary) {
    return c.json(authError("room_not_found", "That room does not exist."), 404);
  }

  const allowed = await loadRoomHistoryAccess(c.env.DB, roomId, user.id);
  if (!allowed) {
    return c.json(authError("forbidden", "You do not have access to this room."), 403);
  }

  const response: RoomDetailResponse = {
    inviteUrl: inviteUrlForToken(c.req.raw, room.inviteToken),
    room: summary
  };

  return c.json(response);
});

app.get("/api/rooms/:roomId/history", async (c) => {
  const roomId = c.req.param("roomId");
  const user = c.get("authUser");
  const room = await loadRoomRow(c.env.DB, roomId);
  if (!room) {
    return c.json(authError("room_not_found", "That room does not exist."), 404);
  }

  const allowed = await loadRoomHistoryAccess(c.env.DB, roomId, user.id);
  if (!allowed) {
    return c.json(authError("forbidden", "You do not have access to this room."), 403);
  }

  const games = await loadRoomGames(c.env.DB, roomId);
  const response: RoomHistoryResponse = { games };

  return c.json(response);
});

app.get("/api/history/games", async (c) => {
  const user = c.get("authUser");
  const games = await loadUserFinishedGames(c.env.DB, user.id);
  const response: UserHistoryResponse = { games };
  return c.json(response);
});

app.get("/api/games/:gameId", async (c) => {
  const gameId = c.req.param("gameId");
  const user = c.get("authUser");
  const game = await loadGameSummary(c.env.DB, gameId);

  if (!game) {
    return c.json(authError("game_not_found", "That game does not exist."), 404);
  }

  const [liveViewerRole, viewerGamePlayer] = await Promise.all([
    loadRoomViewerRole(c.env.DB, game.roomId, user.id),
    loadGamePlayer(c.env.DB, gameId, user.id)
  ]);

  const viewerRole = liveViewerRole ?? (viewerGamePlayer ? "member" : null);
  if (!viewerRole) {
    return c.json(authError("forbidden", "You do not have access to this game replay."), 403);
  }

  if (game.endedAt === null) {
    return c.json(authError("game_in_progress", "Replay is only available after the game has finished."), 409);
  }

  const [events, roster] = await Promise.all([loadGameEvents(c.env.DB, gameId), loadGamePlayerRoster(c.env.DB, gameId)]);

  const filteredEvents = events.filter((event) =>
    canViewReplayEvent(event, {
      isGameHost: viewerGamePlayer?.isHost === 1,
      isSpectator: viewerRole === "spectator",
      team: viewerGamePlayer?.team ?? null,
      userId: user.id
    })
  );

  const response: GameReplayResponse = {
    events: filteredEvents,
    game,
    players: roster.map<ReplayPlayerSummary>((player) => ({
      displayName: player.displayName,
      userId: player.userId
    }))
  };

  return c.json(response);
});

app.get("/api/rooms/:roomId/ws", async (c) => {
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") {
    return c.json(authError("invalid_request", "Expected a websocket upgrade request."), 426);
  }

  const roomId = c.req.param("roomId");
  const user = c.get("authUser");
  const room = await loadRoomRow(c.env.DB, roomId);

  if (!room) {
    return c.json(authError("room_not_found", "That room does not exist."), 404);
  }

  const allowed = await loadRoomAccess(c.env.DB, roomId, user.id);
  if (!allowed) {
    return c.json(authError("forbidden", "You do not have access to this room."), 403);
  }

  const stub = c.env.ROOMS.get(c.env.ROOMS.idFromName(roomId));
  const url = new URL("https://rooms.internal/ws");
  url.searchParams.set("roomId", roomId);

  const headers = new Headers();
  headers.set("Upgrade", "websocket");
  headers.set("x-avalon-display-name", user.displayName);
  headers.set("x-avalon-room-id", roomId);
  headers.set("x-avalon-user-id", user.id);
  headers.set("x-avalon-username", user.username);

  return stub.fetch(
    new Request(url, {
      headers,
      method: "GET"
    })
  );
});

export default app;
