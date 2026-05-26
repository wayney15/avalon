# Live Activity Refresh Bug Fixes

## Problem

Refreshing the page during an active game cleared the previously visible live activity feed, even though new websocket events continued to appear.

Two follow-up bugs were also identified during review:

- stale live activity could remain visible after the game ended and the room returned to the lobby
- reconnect activity was not restored after refresh, which could make the hydrated log imply the game was still paused

## Changes Implemented

### 1. Server-hydrated activity log

- Added `activityLog` to the `room.snapshot` payload in [packages/shared/src/room.ts](/mnt/h/avalon/avalon/packages/shared/src/room.ts:68)
- The API now rebuilds recent visible game activity from persisted `game_events` during snapshot generation in [apps/api/src/room-state.ts](/mnt/h/avalon/avalon/apps/api/src/room-state.ts:54)
- This allows refresh and reconnect to restore recent game activity immediately

### 2. Correct client snapshot reconciliation

- The web client now treats snapshot activity as authoritative when a `room.snapshot` arrives
- This fixes the original refresh bug and also clears stale activity after a game finishes or is terminated
- Implemented in [apps/web/src/app.tsx](/mnt/h/avalon/avalon/apps/web/src/app.tsx:701) using [apps/web/src/live-activity.ts](/mnt/h/avalon/avalon/apps/web/src/live-activity.ts:1)

### 3. Reconnect activity restoration

- Added formatting for persisted `player.reconnected` events in [apps/api/src/room-state.ts](/mnt/h/avalon/avalon/apps/api/src/room-state.ts:137)
- After a reconnect, a refreshed page now shows that the player reconnected instead of leaving the activity feed in a paused-looking state

## Tests Added

- [apps/web/src/live-activity.test.ts](/mnt/h/avalon/avalon/apps/web/src/live-activity.test.ts:1)
  - verifies stale lobby activity is cleared by snapshot reconciliation
  - verifies reconnect hydration uses snapshot activity
- [apps/api/src/room-state.test.ts](/mnt/h/avalon/avalon/apps/api/src/room-state.test.ts:1)
  - verifies reconnect activity is included in the hydrated snapshot log

## Verification

- `npx vitest run apps/api/src/room-state.test.ts apps/api/src/room-coordinator.test.ts apps/api/src/index.test.ts apps/web/src/live-activity.test.ts`
- `npm run typecheck`
