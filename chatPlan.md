# Predefined In-Game Chat

## Summary
- Add a live-only predefined chat feature for active games.
- Show a `Chat` button on the right side of the top bar only for current-game players while a game is in progress.
- Load the selectable sentence list from `apps/web/asset/sentence.txt`.
- Broadcast the selected sentence to other current-game players as a dismissible popup in the format `player_display_name: {sentence}`.

## Implementation Changes
- Extend the websocket contract with:
  - `game.send-predefined-chat` client event
  - `game.predefined-chat.sent` server event
- Add worker-side validation for:
  - active room/game match
  - sender is part of the active player roster
  - game is still in an active phase
  - sentence is part of the predefined allowlist
- Add top-bar `Chat` UI, scrollable dropdown list, and queued popup handling in the web app.
- Keep the feature live-only; do not persist chat sends into replay/history data.

## Test Plan
- Valid player send rebroadcasts to other current-game players only.
- Spectators cannot send predefined chat.
- Invalid game state, invalid phase, and invalid sentence return websocket errors.
- `Chat` button is hidden outside active gameplay and for spectators.
- Popup messages queue and display sequentially until dismissed.

## Assumptions
- Recipients are current-game players only; spectators do not receive the popup.
- Popups queue instead of stacking or replacing one another.
- `apps/web/asset/sentence.txt` remains the sentence source used by the web app.
