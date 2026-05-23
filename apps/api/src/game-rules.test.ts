import { describe, expect, it } from "vitest";

import { buildViewerSecretState, isTwoFailMission, missionTeamSize, validateRoleSelection } from "./game-rules";

describe("validateRoleSelection", () => {
  it("fills unnamed good and evil slots to match player count", () => {
    const result = validateRoleSelection(["merlin", "percival", "assassin", "morgana"], 5);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.roles).toEqual(
      expect.arrayContaining(["merlin", "percival", "assassin", "morgana", "loyal-servant"])
    );
    expect(result.roles).toHaveLength(5);
  });

  it("rejects role pools that exceed the allowed evil count", () => {
    const result = validateRoleSelection(
      ["merlin", "percival", "assassin", "morgana", "mordred"],
      5
    );

    expect(result).toEqual({
      message: "Expected at most 3 good roles and 2 evil roles for 5 players.",
      ok: false
    });
  });

  it("requires morgana exactly once", () => {
    const result = validateRoleSelection(["merlin", "percival", "assassin"], 5);

    expect(result).toEqual({
      message: "Morgana is required exactly once.",
      ok: false
    });
  });
});

describe("mission rules", () => {
  it("returns the official mission size matrix", () => {
    expect(missionTeamSize(5, 1)).toBe(2);
    expect(missionTeamSize(7, 4)).toBe(4);
    expect(missionTeamSize(10, 5)).toBe(5);
  });

  it("only enables the two-fail rule on mission 4 with 7+ players", () => {
    expect(isTwoFailMission(7, 4)).toBe(true);
    expect(isTwoFailMission(6, 4)).toBe(false);
    expect(isTwoFailMission(8, 3)).toBe(false);
  });
});

describe("buildViewerSecretState", () => {
  const assignments = [
    { displayName: "Merlin", role: "merlin", seatIndex: 0, team: "good", userId: "u1" },
    { displayName: "Percival", role: "percival", seatIndex: 1, team: "good", userId: "u2" },
    { displayName: "Assassin", role: "assassin", seatIndex: 2, team: "evil", userId: "u3" },
    { displayName: "Morgana", role: "morgana", seatIndex: 3, team: "evil", userId: "u4" },
    { displayName: "Servant", role: "loyal-servant", seatIndex: 4, team: "good", userId: "u5" }
  ] as const;

  it("shows Merlin and Morgana as indistinguishable to Percival", () => {
    const secretState = buildViewerSecretState("u2", "member", [...assignments]);

    expect(secretState?.viewerRole).toBe("player");
    if (!secretState || secretState.viewerRole !== "player") {
      return;
    }

    expect(secretState.visiblePlayers).toEqual([
      { displayName: "Merlin", reason: "merlin-or-morgana", userId: "u1" },
      { displayName: "Morgana", reason: "merlin-or-morgana", userId: "u4" }
    ]);
  });

  it("reveals a disconnected player's full role information once the host marks them revealed", () => {
    const secretState = buildViewerSecretState("u5", "member", [...assignments], ["u3"]);

    expect(secretState?.viewerRole).toBe("player");
    if (!secretState || secretState.viewerRole !== "player") {
      return;
    }

    expect(secretState.visiblePlayers).toEqual([
      {
        displayName: "Assassin",
        reason: "revealed-disconnected-player",
        role: "assassin",
        team: "evil",
        userId: "u3"
      }
    ]);
  });

  it("gives spectators the full role map", () => {
    const secretState = buildViewerSecretState("spectator", "spectator", [...assignments]);

    expect(secretState?.viewerRole).toBe("spectator");
    expect(secretState?.visiblePlayers).toHaveLength(assignments.length);
    expect(secretState?.visiblePlayers[0]).toMatchObject({
      displayName: "Merlin",
      reason: "all-roles-visible-to-spectator",
      role: "merlin",
      team: "good",
      userId: "u1"
    });
  });
});
