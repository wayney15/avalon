import type { RoomActivityItem, RoomSnapshotEventPayload } from "../../../packages/shared/src";

export function reconcileLiveActivityFromSnapshot(
  _current: RoomActivityItem[],
  snapshot: RoomSnapshotEventPayload
): RoomActivityItem[] {
  return snapshot.activityLog;
}
