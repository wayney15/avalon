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
