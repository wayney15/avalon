# Rules Gap Review

This document reviews the mapping from `rules.md` into the planned backend state machine and calls out the remaining logic decisions the next agent should preserve explicitly.

## Rules That Are Already Mapped Correctly

- player counts from 5 to 10
- exact good/evil team count by player number
- mission size matrix by player count and round
- Mission 4 two-fail rule only for 7+ player games
- hidden simultaneous team voting
- good players locked to `success` on quests
- assassination after 3 successful good missions
- evil instant win after 5 consecutive rejected proposals
- Merlin visibility excluding Mordred
- Percival visibility of Merlin and Morgana as indistinguishable candidates
- Oberon isolation from the rest of evil while still visible to Merlin

## Logic Gaps To Preserve In The Next Implementation

### 1. Role Pool Validation Needs To Be Formalized

`rules.md` says:
- host selects the characters needed for the game
- Merlin and Percival are always included on the good side

This means the implementation must validate:
- selected roles contain `merlin`
- selected roles contain `percival`
- selected roles contain exactly one `assassin`
- selected role pool produces the exact required number of good and evil players for the chosen player count
- optional evil roles cannot exceed the required evil count
- remaining empty slots must be filled with:
  - `loyal-servant` for good
  - `minion` for evil

Recommended explicit rule:
- host chooses only named special roles
- backend auto-fills unnamed remaining slots with vanilla roles

### 2. Night Phase Advancement Is Not Fully Specified

The current documents mention press-and-hold reveal, but not who advances the game.

Recommended v1 rule:
- after game start, the server immediately enters `night`
- each client receives its personalized secret state
- the host explicitly advances from `night` to `proposal`

Reason:
- it avoids hidden timing assumptions
- it gives slow mobile clients time to reveal secret information

### 3. Spectator Visibility Needs Replay Consistency

Product decisions say:
- spectators can exist in lobby and during game
- spectators can see all roles
- locked room blocks all new joins

Implications:
- only spectators already in the room before lock may remain during the active game
- replay endpoints must allow spectators full-role visibility
- ordinary players must still receive filtered replay payloads

### 4. Active Player Definition Must Be Stable

The rules assume all players vote.
The product also says disconnected players pause the game.

Recommended explicit rule:
- while a game is active, the active player set is the immutable `game_players` roster
- no substitutions are allowed
- if any active player disconnects, the game pauses rather than shrinking the voter set

### 5. Host Force-Removal Is A Product Override, Not A Core Avalon Rule

This behavior is outside tabletop rules and must stay explicit:
- if a disconnected player does not return, host may force-remove them
- the current game terminates immediately
- the result is persisted as `unfinished`
- it is not counted as good or evil victory

### 6. Leader Rotation Needs One Concrete Interpretation

`rules.md` says leader passes sequentially at the beginning of every proposal attempt and again after ongoing rounds.

Recommended implementation interpretation:
- the initial leader is based on current seat order
- on every rejected proposal, leader advances by one seat
- after a completed mission, leader advances by one seat for the next round
- seat randomization only happens between games, never during a game

### 7. Public Vote Reveal Must Be Full And Simultaneous

The rules require all votes broadcast simultaneously after all players submit.

Implementation implication:
- do not stream partial vote counts
- do not show who has voted versus who has not unless you intentionally want that UX

Recommended v1 rule:
- the server may show count of received votes only if it does not identify which players have voted
- safer default: show no interim vote status beyond waiting state

### 8. Quest Result Reveal Must Avoid Submission Correlation

The rules require shuffling quest cards before reveal.

Implementation implication:
- never preserve order of submission in payload
- do not leak per-card timestamps
- do not leak server logs to clients

### 9. Final Role Reveal Must Be Timed To End Of Game Only

Product persistence requires final role reveal after game end.

Implementation implication:
- final role map belongs in:
  - end-of-game UI
  - replay history
- final role map must not be broadcast before terminal state

### 10. Locked Room Policy Is Stricter Than Default Spectator Logic

There is a product tension:
- spectators are allowed during game
- locked room blocks nobody from joining

Resolved interpretation from discussion:
- spectators already present before lock may remain
- no new spectators may join once locked

## Recommended Extra Acceptance Checks

- invalid role pools are rejected before game start
- Merlin never sees Mordred
- non-Oberon evil players never see Oberon
- Percival sees exactly two indistinguishable Merlin candidates when Morgana is present
- players not on quest team cannot submit quest vote
- active game player roster never changes except termination
- spectators present before lock remain connected through game
- new spectators are rejected once room is locked
- replay for ordinary players excludes hidden role assignment events they should not know
- replay for spectators can include full role map
