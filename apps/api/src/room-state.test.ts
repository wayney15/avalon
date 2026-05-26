import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRoomSnapshotPayload } from "./room-state";

vi.mock("./rooms", () => ({
  loadActiveGameState: vi.fn(),
  loadActiveGameView: vi.fn(),
  loadGamePlayerRoster: vi.fn(),
  loadRoomViewerRole: vi.fn(),
  loadViewerSecretState: vi.fn()
}));

import {
  loadActiveGameState,
  loadActiveGameView,
  loadGamePlayerRoster,
  loadRoomViewerRole,
  loadViewerSecretState
} from "./rooms";

function createFakeDb(events: Array<Record<string, unknown>> = []): D1Database {
  return {
    prepare(query: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async all() {
              if (query.includes("FROM room_members")) {
                return {
                  results: [
                    {
                      displayName: "Host",
                      isHost: 1,
                      seatIndex: 0,
                      userId: "host-1"
                    }
                  ]
                };
              }

              if (query.includes("FROM room_spectators")) {
                return {
                  results: []
                };
              }

              if (query.includes("FROM game_events")) {
                return {
                  results: events
                };
              }

              throw new Error(`Unhandled all() query: ${query} :: ${JSON.stringify(params)}`);
            },
            async first() {
              if (query.includes("FROM rooms")) {
                return {
                  activeGameId: "game-1",
                  code: "ABCDE",
                  hostUserId: "host-1",
                  id: "room-1",
                  name: "Room",
                  status: "locked"
                };
              }

              throw new Error(`Unhandled first() query: ${query} :: ${JSON.stringify(params)}`);
            }
          };
        }
      };
    }
  } as D1Database;
}

describe("loadRoomSnapshotPayload activity hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadActiveGameView).mockResolvedValue({
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
    });
    vi.mocked(loadActiveGameState).mockResolvedValue({
      attempt: 1,
      leaderUserId: "host-1",
      rejectTracker: 0,
      round: 1,
      status: "proposal"
    });
    vi.mocked(loadRoomViewerRole).mockResolvedValue("member");
    vi.mocked(loadViewerSecretState).mockResolvedValue(null);
    vi.mocked(loadGamePlayerRoster).mockResolvedValue([
      {
        displayName: "Host",
        isHost: 1,
        role: "merlin",
        seatIndex: 0,
        team: "good",
        userId: "host-1"
      },
      {
        displayName: "Assassin",
        isHost: 0,
        role: "assassin",
        seatIndex: 1,
        team: "evil",
        userId: "player-2"
      }
    ]);
  });

  it("hydrates reconnect activity so refresh does not imply the game is still paused", async () => {
    const payload = await loadRoomSnapshotPayload(
      createFakeDb([
        {
          actorUserId: "player-2",
          createdAt: "2026-05-26T12:01:00.000Z",
          eventType: "player.reconnected",
          id: "evt-2",
          payloadJson: JSON.stringify({ gameId: "game-1", reconnectedUserId: "player-2" }),
          subjectUserId: "player-2",
          visibleTo: "all"
        },
        {
          actorUserId: "player-2",
          createdAt: "2026-05-26T12:00:00.000Z",
          eventType: "player.disconnected",
          id: "evt-1",
          payloadJson: JSON.stringify({ disconnectedUserId: "player-2", gameId: "game-1" }),
          subjectUserId: "player-2",
          visibleTo: "all"
        }
      ]),
      "room-1",
      new Set(["host-1"]),
      "host-1"
    );

    expect(payload?.activityLog).toEqual([
      {
        id: "evt-2",
        message: "Assassin 已重新连接。",
        occurredAt: "2026-05-26T12:01:00.000Z"
      },
      {
        id: "evt-1",
        message: "Assassin 已断线，游戏暂停。",
        occurredAt: "2026-05-26T12:00:00.000Z"
      }
    ]);
  });
});
