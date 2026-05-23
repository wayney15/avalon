import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSnapshotEventPayload } from "../../../packages/shared/src";

vi.mock("./room-state", () => ({
  loadRoomPresenceState: vi.fn(),
  loadRoomSnapshotPayload: vi.fn()
}));

vi.mock("./rooms", () => ({
  appendGameEvent: vi.fn(),
  createStartedGame: vi.fn(),
  finalizeGame: vi.fn(),
  loadActiveGameState: vi.fn(),
  loadGamePlayerRoster: vi.fn(),
  loadRoomMemberRoster: vi.fn(),
  loadRoomRow: vi.fn(),
  persistGameState: vi.fn(),
  randomizeRoomSeats: vi.fn(),
  removeRoomParticipant: vi.fn(),
  removeRoomSpectator: vi.fn(),
  swapRoomSeats: vi.fn(),
  transferRoomHost: vi.fn(),
  updateGameScore: vi.fn(),
  updateRoomTimestamp: vi.fn(),
  upsertRoomMember: vi.fn(),
  upsertRoomSpectator: vi.fn()
}));

import { RoomCoordinator } from "./room-coordinator";
import { loadRoomSnapshotPayload } from "./room-state";
import { appendGameEvent, loadActiveGameState, loadGamePlayerRoster, loadRoomRow, persistGameState } from "./rooms";

function createMockSocket() {
  return {
    close: vi.fn(),
    send: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn()
  } as unknown as WebSocket;
}

function createCoordinator(socket: WebSocket) {
  const db = {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async first() {
              if (query.includes("FROM games") && params[0] === "game-1") {
                return {
                  endedAt: "2026-05-23T12:00:00.000Z",
                  id: "game-1",
                  roomId: "room-1",
                  startedAt: "2026-05-23T11:00:00.000Z",
                  status: "unfinished",
                  winner: null
                };
              }

              throw new Error(`Unhandled query in room-coordinator test: ${query}`);
            }
          };
        }
      };
    }
  } as unknown as D1Database;

  const state = {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn(() => [])
  } as unknown as DurableObjectState;

  const coordinator = new RoomCoordinator(state, {
    DB: db,
    JWT_ISSUER: "issuer",
    JWT_SECRET: "secret",
    ROOMS: {} as DurableObjectNamespace
  });

  (coordinator as any).connections.set("connection-1", {
    roomId: "room-1",
    socket,
    user: {
      displayName: "Host",
      id: "host-1",
      username: "host"
    },
    userId: "host-1"
  });

  return coordinator;
}

function snapshotPayload(): RoomSnapshotEventPayload {
  return {
    activeGame: {
      assassination: null,
      attempt: 1,
      id: "game-1",
      leaderUserId: "host-1",
      missionResults: [],
      missionScores: { evil: 0, good: 0 },
      missionSize: 2,
      pendingTeamVoteUserIds: null,
      proposedTeamUserIds: null,
      rejectTracker: 0,
      round: 1,
      status: "proposal",
      teamVotesSubmitted: null
    },
    lockStatus: "locked",
    players: [
      { connected: true, displayName: "Host", role: "host", userId: "host-1" },
      { connected: false, displayName: "Assassin", role: "player", userId: "player-2" }
    ],
    room: {
      code: "ABCDE",
      hostId: "host-1",
      id: "room-1",
      name: "Room",
      visibility: "locked"
    },
    seats: [],
    spectators: [],
    viewerActionState: null,
    viewerSecretState: null
  };
}

describe("RoomCoordinator websocket event handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadRoomSnapshotPayload).mockResolvedValue(snapshotPayload());
  });

  it("advances an active game from night to proposal when the host sends game.advance-to-proposal", async () => {
    vi.mocked(loadRoomRow).mockResolvedValue({
      activeGameId: "game-1",
      code: "ABCDE",
      createdAt: "",
      hostUserId: "host-1",
      id: "room-1",
      inviteToken: "invite",
      name: "Room",
      status: "locked",
      updatedAt: ""
    });
    vi.mocked(loadActiveGameState).mockResolvedValue({
      attempt: 1,
      disconnectedUserIds: [],
      leaderUserId: "host-1",
      rejectTracker: 0,
      round: 1,
      status: "night"
    });
    vi.mocked(appendGameEvent).mockResolvedValue(1);
    vi.mocked(persistGameState).mockResolvedValue();

    const socket = createMockSocket();
    const coordinator = createCoordinator(socket);

    await coordinator.webSocketMessage(
      socket,
      JSON.stringify({
        payload: { gameId: "game-1" },
        type: "game.advance-to-proposal"
      })
    );

    expect(appendGameEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "host-1",
        eventType: "game.phase.changed",
        gameId: "game-1",
        payload: expect.objectContaining({
          attempt: 1,
          gameId: "game-1",
          leaderUserId: "host-1",
          phase: "proposal",
          round: 1
        }),
        visibleTo: "all"
      })
    );
    expect(persistGameState).toHaveBeenCalledWith(
      expect.anything(),
      "game-1",
      "host-1",
      expect.objectContaining({
        status: "proposal"
      })
    );

    const sentEvents = vi.mocked(socket.send).mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(sentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            gameId: "game-1",
            phase: "proposal"
          }),
          type: "game.phase.changed"
        }),
        expect.objectContaining({
          type: "room.snapshot"
        })
      ])
    );
  });

  it("persists and rebroadcasts a revealed disconnected player", async () => {
    vi.mocked(loadRoomRow).mockResolvedValue({
      activeGameId: "game-1",
      code: "ABCDE",
      createdAt: "",
      hostUserId: "host-1",
      id: "room-1",
      inviteToken: "invite",
      name: "Room",
      status: "locked",
      updatedAt: ""
    });
    vi.mocked(loadActiveGameState).mockResolvedValue({
      attempt: 2,
      disconnectedUserIds: ["player-2"],
      leaderUserId: "host-1",
      rejectTracker: 1,
      revealedDisconnectedUserIds: [],
      round: 2,
      status: "team-vote",
      teamUserIds: ["host-1", "player-2"],
      teamVotes: {}
    });
    vi.mocked(loadGamePlayerRoster).mockResolvedValue([
      {
        displayName: "Host",
        role: "merlin",
        seatIndex: 0,
        team: "good",
        userId: "host-1"
      },
      {
        displayName: "Assassin",
        role: "assassin",
        seatIndex: 1,
        team: "evil",
        userId: "player-2"
      }
    ]);
    vi.mocked(appendGameEvent).mockResolvedValue(1);
    vi.mocked(persistGameState).mockResolvedValue();

    const socket = createMockSocket();
    const coordinator = createCoordinator(socket);

    await coordinator.webSocketMessage(
      socket,
      JSON.stringify({
        payload: { targetUserId: "player-2" },
        type: "room.reveal-disconnected"
      })
    );

    expect(appendGameEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorUserId: "host-1",
        eventType: "player.disconnected.revealed",
        gameId: "game-1",
        payload: {
          gameId: "game-1",
          targetUserId: "player-2"
        },
        subjectUserId: "player-2",
        visibleTo: "all"
      })
    );
    expect(persistGameState).toHaveBeenCalledWith(
      expect.anything(),
      "game-1",
      "host-1",
      expect.objectContaining({
        revealedDisconnectedUserIds: ["player-2"]
      })
    );

    const sentEvents = vi.mocked(socket.send).mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(sentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "room.snapshot"
        })
      ])
    );
  });

  it("allows the host to end the current game and return the room to the lobby", async () => {
    vi.mocked(loadRoomRow).mockResolvedValue({
      activeGameId: "game-1",
      code: "ABCDE",
      createdAt: "",
      hostUserId: "host-1",
      id: "room-1",
      inviteToken: "invite",
      name: "Room",
      status: "locked",
      updatedAt: ""
    });
    vi.mocked(loadGamePlayerRoster).mockResolvedValue([
      {
        displayName: "Host",
        role: "merlin",
        seatIndex: 0,
        team: "good",
        userId: "host-1"
      },
      {
        displayName: "Assassin",
        role: "assassin",
        seatIndex: 1,
        team: "evil",
        userId: "player-2"
      }
    ]);

    const socket = createMockSocket();
    const coordinator = createCoordinator(socket);

    await coordinator.webSocketMessage(
      socket,
      JSON.stringify({
        payload: { roomId: "room-1" },
        type: "room.end-game"
      })
    );

    const appendCalls = vi.mocked(appendGameEvent).mock.calls.map(([, options]) => options);
    expect(appendCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "roles.revealed",
          gameId: "game-1"
        }),
        expect.objectContaining({
          eventType: "game.terminated",
          gameId: "game-1",
          payload: {
            gameId: "game-1",
            reason: "host_ended_game",
            status: "unfinished"
          }
        })
      ])
    );

    const sentEvents = vi.mocked(socket.send).mock.calls.map(([message]) => JSON.parse(String(message)));
    expect(sentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload: {
            gameId: "game-1",
            reason: "host_ended_game",
            status: "unfinished"
          },
          type: "game.terminated"
        }),
        expect.objectContaining({
          payload: { roomId: "room-1" },
          type: "room.unlocked"
        }),
        expect.objectContaining({
          type: "room.snapshot"
        })
      ])
    );
  });
});
