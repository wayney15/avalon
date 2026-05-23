# The Resistance: Avalon — Comprehensive Game Rules & App Logic Specification

This document serves as the definitive ruleset and programmatic specifications for **The Resistance: Avalon**. It outlines player metrics, asymmetric information matrices, game loops, state machine structures, and edge cases required to build a compliant web application.

---

## 1. Role Matrix & Information Hierarchy

Avalon is an asymmetric hidden-role game divided into two opposing teams: **Good** (Loyal Servants of Arthur) and **Evil** (Minions of Mordred). 

### Team Metrics & Allocations
The game scales from 5 to 10 players. The backend configuration must initialize roles according to the following strict mathematical distribution:

| Total Players | Good Players | Evil Players |
| :---: | :---: | :---: |
| **5** | 3 | 2 |
| **6** | 4 | 2 |
| **7** | 4 | 3 |
| **8** | 5 | 3 |
| **9** | 6 | 3 |
| **10** | 6 | 4 |

Let the host select the characters needed for this game when starting a room. The selection should be a table where the user can select the roles he wants to have for the game. The good side always consist of Merlin and Percival, the rest of good players are Loyal Servants.


### Character Visibility Permissions
During the initialization phase ("The Night Phase"), specific roles are granted targeted read permissions regarding the identities of other players. The roles are assigned to players at random based on the host selected pool of roles.

```
       [ PLAYER ASSIGNMENT ]
                 │
        ┌────────┴────────┐
        ▼                 ▼
   [ GOOD TEAM ]     [ EVIL TEAM ]
   ├── Merlin        ├── Assassin
   ├── Percival      ├── Morgana
   └── Vanilla Good  ├── Mordred
                     ├── Oberon
                     └── Vanilla Evil
```

| Character | Team | What They See / App Visibility State |
| :--- | :---: | :--- |
| **Merlin** | Good | Sees all Evil players **except Mordred**. (Sees Assassin, Morgana, Oberon, and Vanilla Evil). |
| **Percival** | Good | Sees **Merlin and Morgana**, but they look identical. (Must distinguish them through social deduction). |
| **Loyal Servant** | Good | Sees no one. Has no information. |
| **Assassin** | Evil | Sees all other Evil players **except Oberon**. Knows who belongs to the Evil team. |
| **Morgana** | Evil | Sees all other Evil players **except Oberon**. Appears to Percival as a "Merlin candidate." |
| **Mordred** | Evil | Sees all other Evil players **except Oberon**. Hidden completely from Merlin. |
| **Oberon** | Evil | **Sees nobody.** Does not know who the other Evil players are. Other Evil players do not know who Oberon is. (However, Merlin still sees Oberon as Evil). |
| **Minion of Mordred**| Evil | Sees all other Evil players **except Oberon**. |

---

## 2. Core Game Loop & State Machine

The game is structured as a strict state machine with a maximum of 5 rounds. Each round continues until a mission team is successfully approved and executes their quest.

```
┌────────────────────────────────────────────────────────┐
│                      1. SETUP                          │
│  (Distribute Roles -> Secret Night Info Phase)         │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│               2. TEAM PROPOSAL (Leader)                │
│  (Select players according to Mission Matrix)          │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│                3. PUBLIC VOTING (All)                  │
│  (Simultaneous Approve / Reject on proposed team)      │
└──────────────────────────┬─────────────────────────────┘
                           │
                 ┌─────────┴─────────┐
                 ▼ Approved?         ▼ Rejected
       ┌──────────────────┐    ┌─────────────────────────────────┐
       │     YES          │    │             NO                  │
       └─────────┬────────┘    │  - Increment Vote Tracker (+1)  │
                 │             │  - Pass Leader Clockwise        │
                 │             └────────────────┬────────────────┘
                 │                              │
                 │                     ┌────────┴────────┐
                 │                     ▼ Track == 5?     ▼ Track < 5
                 │             ┌───────────────┐   ┌─────────────────────┐
                 │             │  EVIL WINS    │   │ Return to Proposal  │
                 │             └───────────────┘   └─────────────────────┘
                 ▼
┌────────────────────────────────────────────────────────┐
│             4. QUEST EXECUTION (Team Only)             │
│  (Secret Pass / Fail tokens submitted and shuffled)     │
└──────────────────────────┬─────────────────────────────┘
                           ▼
┌────────────────────────────────────────────────────────┐
│              5. EVALUATE & SCORE ROUND                 │
│  (Log point to winning side; Reset Vote Tracker to 0)   │
└──────────────────────────┬─────────────────────────────┘
                           │
                ┌──────────┴──────────┐
                ▼ 3 Points Scored?    ▼ Ongoing
     ┌───────────────────────┐   ┌───────────────────────┐
     │          YES          │   │ Pass Leader Clockwise │
     └──────────┬────────────┘   │ Move to next Round    │
                │                └───────────────────────┘
                ▼
     ┌───────────────────────┐
     │ 6. WIN DETERMINATION  │
     │ - 3 Evil Points = Evil│
     │ - 3 Good Points = Go  │
     │   to Assassination    │
     └───────────────────────┘
```

### Phase A: Team Proposal
1. **Leader Rotation:** The Leader token transfers sequentially (clockwise) to the next player at the beginning of every proposal attempt.
2. **Nomination:** The current Leader selects a subset of players. The size of the subset depends on the current Round and total Player Count.

#### Mission Size Scaling Matrix
The app must validate that the number of selected players perfectly matches this grid:

| Total Players | Mission 1 | Mission 2 | Mission 3 | Mission 4 | Mission 5 |
| :---: | :---: | :---: | :---: | :---: | :---: |
| **5 Players** | 2 | 3 | 2 | 3 | 3 |
| **6 Players** | 2 | 3 | 4 | 3 | 4 |
| **7 Players** | 2 | 3 | 3 | 4* | 4 |
| **8 Players** | 3 | 4 | 4 | 5* | 5 |
| **9 Players** | 3 | 4 | 4 | 5* | 5 |
| **10 Players**| 3 | 4 | 4 | 5* | 5 |

> **\* The Two-Fail Requirement:** In games featuring **7 or more players**, Mission 4 requires at least **two (2) Fail cards** to sabotage the quest. For all other instances in the grid, a single "Fail" card causes the mission to fail.

### Phase B: Public Team Voting
1. **Voting:** Every player in the game must cast a public vote: `Approve` or `Reject`.
2. **Resolution:** Votes must be held in a hidden state on the server until *all* active players have cast their ballot. Once complete, the backend broadcasts all selections simultaneously.
3. **Majority Rules:** * If `Approve` votes > `Reject` votes, the team is successfully formed. The game moves to **Phase C**.
   * If `Approve` votes <= `Reject` votes (including ties), the team is rejected. 
4. **The Vote Tracker (The Hammer):** * Rejecting a team advances the **Vote Tracker** counter by 1.
   * If the Vote Tracker reaches **5** (meaning 5 consecutive proposals were rejected in a single round), the state transitions immediately to an **Instant Evil Victory**.
   * When a team is successfully approved, the Vote Tracker resets to **0** for the next round.

### Phase C: Quest Execution
Only players who were nominated and approved for the team participate in this phase.
1. **Secret Balloting:** Players cast a secret action token: `Success` or `Fail`.
2. **Role Constraints:** * **Good Players** are programmatically locked to selecting `Success`. They cannot throw a mission.
   * **Evil Players** may select either `Success` (to mask their identity) or `Fail` (to sabotage).
3. **Array Shuffling:** To maintain absolute anonymity, the server **must** process the input cards through a cryptographic shuffle algorithm (e.g., Fisher-Yates) before transmitting the data or updating the frontend array. *Never expose individual indexes or timestamps linked to submission orders.*
4. **Score Evaluation:**
   * **7+ Players AND Mission 4:** Requires $\geq 2$ `Fail` inputs to score an Evil point.
   * **All other scenarios:** Requires $\geq 1$ `Fail` input to score an Evil point.
   * If the failure criteria are met, the round is awarded to **Evil**. If not, the round is awarded to **Good**.

---

## 3. End Game & Win Conditions

The application must continuously evaluate end-game conditions at the close of every quest phase or voting phase.

### Instant Evil Victory
The app instantly terminates and declares Evil the winner if:
* The Evil team successfully secures **3 failed missions** on the game board.
* The Vote Tracker hits **5 failed proposals** within a single round.

### Good Success: Transition to The Assassination Phase
If the Good team successfully passes **3 missions**, the game freezes and enters the **Assassination Phase**. Good has not won yet.

1. **Lock Actions:** Disable all chat, voting, and baseline UI structures for the Good players.
2. **Expose Evil:** Reveal all Evil players to one another on screen to facilitate consultation.
3. **The Target Selection:** The player holding **The Assassin** role is presented with a private interface containing the names of all players on the Good team.
4. **Execution:** The Assassin selects exactly one player suspected of being **Merlin**.
5. **Final Evaluation:**
   * If the target is **Merlin**: The strike is successful. The game ends in an **Evil Victory**.
   * If the target is **Any Other Character**: The strike fails. The game ends in a **Good Victory**.

---

## 4. Web Application Implementation Requirements

To ensure a seamless user experience, the system architecture should implement the following engineering guidelines:

* **Real-time State Synchronization:** Use persistent full-duplex communication protocols (such as WebSockets via Socket.io) to ensure synchronized voting countdowns, state transformations, and simultaneous reveals across all active client screens.
* **Data Sanitization:** The server backend must act as the ultimate source of truth. Under no circumstances should the client-side state mirror data fields that the user's role is not authorized to know (e.g., hiding the global role array from browser network inspectors or Redux/Vuex state logs).
* **Intent-Confirmation Overlays:** To prevent accidental reveals or catastrophic miss-clicks in an individual device setting, implement confirmation modals or "press-and-hold to view" buttons for sensitive operations (such as viewing your initial secret role or executing the final assassination).