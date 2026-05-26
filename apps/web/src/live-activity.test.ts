import { describe, expect, it } from "vitest";
import type { RoomSnapshotEventPayload } from "../../../packages/shared/src";
import { reconcileLiveActivityFromSnapshot } from "./live-activity";

function snapshot(activityLog: RoomSnapshotEventPayload["activityLog"]): RoomSnapshotEventPayload {
  return {
    activeGame: null,
    activityLog,
    lockStatus: "open",
    players: [],
    room: {
      code: "ABCDE",
      hostId: "host-1",
      id: "room-1",
      name: "Room",
      visibility: "open"
    },
    seats: [],
    spectators: [],
    viewerActionState: null,
    viewerSecretState: null
  };
}

describe("reconcileLiveActivityFromSnapshot", () => {
  it("clears stale live activity when the authoritative snapshot has none", () => {
    const current = [
      {
        id: "old-1",
        message: "游戏结束，好人胜利。",
        occurredAt: "2026-05-26T12:00:00.000Z"
      }
    ];

    expect(reconcileLiveActivityFromSnapshot(current, snapshot([]))).toEqual([]);
  });

  it("hydrates live activity from the authoritative snapshot after reconnect", () => {
    const hydrated = [
      {
        id: "evt-1",
        message: "玩家 A 已重新连接。",
        occurredAt: "2026-05-26T12:01:00.000Z"
      }
    ];

    expect(reconcileLiveActivityFromSnapshot([], snapshot(hydrated))).toEqual(hydrated);
  });
});
