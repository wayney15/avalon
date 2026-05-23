import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./jwt", async () => ({
  signJwt: vi.fn(),
  verifyJwt: vi.fn()
}));

import app from "./index";
import { verifyJwt } from "./jwt";

interface FakeDbState {
  events: Array<{
    actorUserId: string | null;
    createdAt: string;
    eventType: string;
    gameId: string;
    id: string;
    payloadJson: string;
    sequenceNo: number;
    subjectUserId: string | null;
    visibleTo: "all" | "host" | "evil" | "good" | "self" | "spectators" | "system";
  }>;
  gamePlayer: { isHost: number; team: "good" | "evil"; userId: string } | null;
  gameSummary: { endedAt: string | null; id: string; roomId: string; startedAt: string; status: "finished" | "unfinished" | "night"; winner: "good" | "evil" | null } | null;
  historyGames: Array<{
    endedAt: string | null;
    id: string;
    roomCode: string;
    roomId: string;
    roomName: string;
    startedAt: string;
    status: "finished";
    winner: "good" | "evil" | null;
  }>;
  replayPlayers: Array<{
    displayName: string;
    isHost?: number;
    role?: string;
    seatIndex?: number;
    team?: "good" | "evil";
    userId: string;
  }>;
  liveViewerRole: "member" | "spectator" | null;
  recentRoomId: string | null;
  roomCounts: { playerCount: number; spectatorCount: number } | null;
  roomDetail: {
    activeGameId: string | null;
    code: string;
    createdAt: string;
    hostUserId: string;
    id: string;
    inviteToken: string;
    name: string;
    status: "open" | "locked" | "archived";
    updatedAt: string;
  } | null;
  user: { displayName: string; id: string; username: string } | null;
}

function createFakeDb(state: FakeDbState): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              if (query.includes("FROM game_events")) {
                return {
                  results: state.events.map((event) => ({
                    ...event,
                    gameId: event.gameId,
                    payloadJson: event.payloadJson
                  }))
                };
              }

              if (query.includes("FROM games") && query.includes("INNER JOIN game_players") && query.includes("rooms.code AS roomCode")) {
                return {
                  results: state.historyGames
                };
              }

              if (query.includes("display_name_snapshot AS displayName") && query.includes("FROM game_players")) {
                return {
                  results: state.replayPlayers
                };
              }

              throw new Error(`Unhandled all() query: ${query}`);
            },
            async first() {
              if (query.includes("FROM users WHERE id = ?")) {
                return state.user;
              }

              if (query.includes("FROM games") && query.includes("WHERE id = ?")) {
                return state.gameSummary;
              }

              if (query.includes("FROM (") && query.includes("ORDER BY activityAt DESC")) {
                return state.recentRoomId ? { roomId: state.recentRoomId } : null;
              }

              if (query.includes("FROM rooms") && query.includes("WHERE id = ?")) {
                return state.roomDetail;
              }

              if (query.includes("SELECT\n        (SELECT COUNT(*) FROM room_members")) {
                return state.roomCounts;
              }

              if (query.includes("FROM game_players") && query.includes("WHERE game_id = ? AND user_id = ?")) {
                return state.gamePlayer;
              }

              if (query.includes("CASE") && query.includes("room_members") && query.includes("room_spectators")) {
                return state.liveViewerRole ? { role: state.liveViewerRole } : { role: null };
              }

              throw new Error(`Unhandled first() query: ${query} :: ${JSON.stringify(params)}`);
            }
          };
        }
      };
    }
  } as D1Database;
}

function createEnv(db: D1Database): Record<string, unknown> {
  return {
    DB: db,
    JWT_ISSUER: "issuer",
    JWT_SECRET: "secret",
    ROOMS: {
      get: vi.fn(),
      idFromName: vi.fn()
    }
  };
}

describe("GET /api/games/:gameId replay filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyJwt).mockResolvedValue({
      displayName: "Viewer",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "issuer",
      sub: "user-1",
      username: "viewer"
    });
  });

  it("allows historical players to access replay but filters hidden events by viewer authorization", async () => {
    const db = createFakeDb({
      events: [
        {
          actorUserId: null,
          createdAt: "2026-05-23T12:00:00.000Z",
          eventType: "game.started",
          gameId: "game-1",
          id: "e1",
          payloadJson: JSON.stringify({ started: true }),
          sequenceNo: 1,
          subjectUserId: null,
          visibleTo: "all"
        },
        {
          actorUserId: "user-1",
          createdAt: "2026-05-23T12:01:00.000Z",
          eventType: "team.vote.submitted",
          gameId: "game-1",
          id: "e2",
          payloadJson: JSON.stringify({ vote: "approve" }),
          sequenceNo: 2,
          subjectUserId: "user-1",
          visibleTo: "self"
        },
        {
          actorUserId: "user-2",
          createdAt: "2026-05-23T12:01:30.000Z",
          eventType: "evil.secret",
          gameId: "game-1",
          id: "e3",
          payloadJson: JSON.stringify({ role: "assassin" }),
          sequenceNo: 3,
          subjectUserId: "user-2",
          visibleTo: "evil"
        },
        {
          actorUserId: null,
          createdAt: "2026-05-23T12:02:00.000Z",
          eventType: "game.state.updated",
          gameId: "game-1",
          id: "e4",
          payloadJson: JSON.stringify({ status: "proposal" }),
          sequenceNo: 4,
          subjectUserId: "__system__",
          visibleTo: "self"
        }
      ],
      gamePlayer: {
        isHost: 0,
        team: "good",
        userId: "user-1"
      },
      gameSummary: {
        endedAt: "2026-05-23T12:10:00.000Z",
        id: "game-1",
        roomId: "room-1",
        startedAt: "2026-05-23T12:00:00.000Z",
        status: "finished",
        winner: "good"
      },
      historyGames: [],
      replayPlayers: [
        { displayName: "Viewer", userId: "user-1" },
        { displayName: "Player Two", userId: "user-2" }
      ],
      liveViewerRole: null,
      recentRoomId: null,
      roomCounts: null,
      roomDetail: null,
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/games/game-1", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { events: Array<{ id: string }> };
    expect(payload.events.map((event: { id: string }) => event.id)).toEqual(["e1", "e2"]);
  });

  it("lets spectators see all replay-hidden events except internal game.state.updated", async () => {
    const db = createFakeDb({
      events: [
        {
          actorUserId: "host-1",
          createdAt: "2026-05-23T12:00:00.000Z",
          eventType: "host.note",
          gameId: "game-1",
          id: "e1",
          payloadJson: JSON.stringify({ note: true }),
          sequenceNo: 1,
          subjectUserId: null,
          visibleTo: "host"
        },
        {
          actorUserId: "evil-1",
          createdAt: "2026-05-23T12:00:10.000Z",
          eventType: "evil.secret",
          gameId: "game-1",
          id: "e2",
          payloadJson: JSON.stringify({ side: "evil" }),
          sequenceNo: 2,
          subjectUserId: "evil-1",
          visibleTo: "evil"
        },
        {
          actorUserId: "user-9",
          createdAt: "2026-05-23T12:00:20.000Z",
          eventType: "spectator.note",
          gameId: "game-1",
          id: "e3",
          payloadJson: JSON.stringify({ side: "spectator" }),
          sequenceNo: 3,
          subjectUserId: "user-9",
          visibleTo: "spectators"
        },
        {
          actorUserId: null,
          createdAt: "2026-05-23T12:00:30.000Z",
          eventType: "game.state.updated",
          gameId: "game-1",
          id: "e4",
          payloadJson: JSON.stringify({ status: "quest-vote" }),
          sequenceNo: 4,
          subjectUserId: "__system__",
          visibleTo: "self"
        }
      ],
      gamePlayer: null,
      gameSummary: {
        endedAt: "2026-05-23T12:10:00.000Z",
        id: "game-1",
        roomId: "room-1",
        startedAt: "2026-05-23T12:00:00.000Z",
        status: "finished",
        winner: "evil"
      },
      historyGames: [],
      replayPlayers: [
        { displayName: "Host One", userId: "host-1" },
        { displayName: "Evil One", userId: "evil-1" },
        { displayName: "Spectator Note", userId: "user-9" }
      ],
      liveViewerRole: "spectator",
      recentRoomId: null,
      roomCounts: null,
      roomDetail: null,
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/games/game-1", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { events: Array<{ id: string }> };
    expect(payload.events.map((event: { id: string }) => event.id)).toEqual(["e1", "e2", "e3"]);
  });

  it("rejects replay access while a game is still in progress", async () => {
    const db = createFakeDb({
      events: [],
      gamePlayer: {
        isHost: 1,
        team: "good",
        userId: "user-1"
      },
      gameSummary: {
        endedAt: null,
        id: "game-1",
        roomId: "room-1",
        startedAt: "2026-05-23T12:00:00.000Z",
        status: "night",
        winner: null
      },
      historyGames: [],
      replayPlayers: [{ displayName: "Viewer", userId: "user-1" }],
      liveViewerRole: "member",
      recentRoomId: null,
      roomCounts: null,
      roomDetail: null,
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/games/game-1", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "game_in_progress"
    });
  });
});

describe("GET /api/rooms/recent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyJwt).mockResolvedValue({
      displayName: "Viewer",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "issuer",
      sub: "user-1",
      username: "viewer"
    });
  });

  it("returns the most recent room available to the signed-in user", async () => {
    const db = createFakeDb({
      events: [],
      gamePlayer: null,
      gameSummary: null,
      historyGames: [],
      replayPlayers: [],
      liveViewerRole: null,
      recentRoomId: "room-9",
      roomCounts: {
        playerCount: 5,
        spectatorCount: 2
      },
      roomDetail: {
        activeGameId: null,
        code: "ABCDE",
        createdAt: "2026-05-23T12:00:00.000Z",
        hostUserId: "host-1",
        id: "room-9",
        inviteToken: "invite-9",
        name: "Friday Room",
        status: "open",
        updatedAt: "2026-05-23T13:00:00.000Z"
      },
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/rooms/recent", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      room: {
        code: "ABCDE",
        id: "room-9",
        name: "Friday Room",
        playerCount: 5,
        spectatorCount: 2
      }
    });
  });

  it("returns null when the signed-in user has no room history", async () => {
    const db = createFakeDb({
      events: [],
      gamePlayer: null,
      gameSummary: null,
      historyGames: [],
      replayPlayers: [],
      liveViewerRole: null,
      recentRoomId: null,
      roomCounts: null,
      roomDetail: null,
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/rooms/recent", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ room: null });
  });
});

describe("GET /api/history/games", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(verifyJwt).mockResolvedValue({
      displayName: "Viewer",
      exp: Math.floor(Date.now() / 1000) + 3600,
      iat: Math.floor(Date.now() / 1000),
      iss: "issuer",
      sub: "user-1",
      username: "viewer"
    });
  });

  it("returns finished games for the signed-in user", async () => {
    const db = createFakeDb({
      events: [],
      gamePlayer: null,
      gameSummary: null,
      historyGames: [
        {
          endedAt: "2026-05-23T12:30:00.000Z",
          id: "game-2",
          roomCode: "ABCDE",
          roomId: "room-1",
          roomName: "Friday Room",
          startedAt: "2026-05-23T12:00:00.000Z",
          status: "finished",
          winner: "good"
        }
      ],
      replayPlayers: [],
      liveViewerRole: null,
      recentRoomId: null,
      roomCounts: null,
      roomDetail: null,
      user: {
        displayName: "Viewer",
        id: "user-1",
        username: "viewer"
      }
    });

    const response = await app.fetch(
      new Request("http://local/api/history/games", {
        headers: {
          Authorization: "Bearer token"
        }
      }),
      createEnv(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      games: [
        {
          endedAt: "2026-05-23T12:30:00.000Z",
          id: "game-2",
          roomCode: "ABCDE",
          roomId: "room-1",
          roomName: "Friday Room",
          startedAt: "2026-05-23T12:00:00.000Z",
          status: "finished",
          winner: "good"
        }
      ]
    });
  });
});
