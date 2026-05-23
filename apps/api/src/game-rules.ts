import type {
  Role,
  Team,
  ViewerSecretState,
  ViewerVisiblePlayer
} from "../../../packages/shared/src";

interface RosterEntry {
  userId: string;
  displayName: string;
  seatIndex: number;
}

interface RoleAssignmentInput {
  userId: string;
  displayName: string;
  seatIndex: number;
  role: Role;
  team: Team;
}

interface TeamCount {
  good: number;
  evil: number;
}

const TEAM_COUNTS: Record<number, { good: number; evil: number }> = {
  5: { evil: 2, good: 3 },
  6: { evil: 2, good: 4 },
  7: { evil: 3, good: 4 },
  8: { evil: 3, good: 5 },
  9: { evil: 3, good: 6 },
  10: { evil: 4, good: 6 }
};

const ALL_ROLES: Role[] = [
  "merlin",
  "percival",
  "loyal-servant",
  "assassin",
  "morgana",
  "mordred",
  "oberon",
  "minion"
];

const UNIQUE_ROLES: Role[] = ["merlin", "percival", "assassin", "morgana", "mordred", "oberon"];
const MISSION_TEAM_SIZES: Record<number, [number, number, number, number, number]> = {
  5: [2, 3, 2, 3, 3],
  6: [2, 3, 4, 3, 4],
  7: [2, 3, 3, 4, 4],
  8: [3, 4, 4, 5, 5],
  9: [3, 4, 4, 5, 5],
  10: [3, 4, 4, 5, 5]
};

function teamForRole(role: Role): Team {
  switch (role) {
    case "merlin":
    case "percival":
    case "loyal-servant":
      return "good";
    default:
      return "evil";
  }
}

function countTeams(roles: readonly Role[]): TeamCount {
  return roles.reduce<TeamCount>(
    (counts, role) => {
      counts[teamForRole(role)] += 1;
      return counts;
    },
    { evil: 0, good: 0 }
  );
}

function shuffleInPlace<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const randomBuffer = new Uint32Array(1);
    crypto.getRandomValues(randomBuffer);
    const swapIndex = randomBuffer[0] % (index + 1);
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}

export function missionTeamSize(playerCount: number, round: number): number | null {
  if (!Number.isInteger(round) || round < 1 || round > 5) {
    return null;
  }

  return MISSION_TEAM_SIZES[playerCount]?.[round - 1] ?? null;
}

export function isTwoFailMission(playerCount: number, round: number): boolean {
  return playerCount >= 7 && round === 4;
}

export function shuffleValues<T>(values: readonly T[]): T[] {
  const shuffled = [...values];
  shuffleInPlace(shuffled);
  return shuffled;
}

export function validateRoleSelection(
  selectedRoles: Role[],
  playerCount: number
): { ok: true; roles: Role[] } | { ok: false; message: string } {
  const teamCounts = TEAM_COUNTS[playerCount];
  if (!teamCounts) {
    return { message: "Games require between 5 and 10 players.", ok: false };
  }

  if (selectedRoles.length < 3 || selectedRoles.length > playerCount) {
    return {
      message: `Provide between 3 and ${playerCount} roles. Merlin, Percival, and Assassin are always required.`,
      ok: false
    };
  }

  const counts = new Map<Role, number>();
  for (const role of selectedRoles) {
    if (!ALL_ROLES.includes(role)) {
      return { message: `${role} is not a supported role.`, ok: false };
    }
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }

  for (const role of UNIQUE_ROLES) {
    if ((counts.get(role) ?? 0) > 1) {
      return { message: `${role} may only be selected once.`, ok: false };
    }
  }

  if ((counts.get("merlin") ?? 0) !== 1) {
    return { message: "Merlin is required exactly once.", ok: false };
  }

  if ((counts.get("percival") ?? 0) !== 1) {
    return { message: "Percival is required exactly once.", ok: false };
  }

  if ((counts.get("assassin") ?? 0) !== 1) {
    return { message: "Assassin is required exactly once.", ok: false };
  }

  const selectedCounts = countTeams(selectedRoles);
  if (selectedCounts.good > teamCounts.good || selectedCounts.evil > teamCounts.evil) {
    return {
      message: `Expected at most ${teamCounts.good} good roles and ${teamCounts.evil} evil roles for ${playerCount} players.`,
      ok: false
    };
  }

  const finalizedRoles = [...selectedRoles];
  for (let index = selectedCounts.good; index < teamCounts.good; index += 1) {
    finalizedRoles.push("loyal-servant");
  }
  for (let index = selectedCounts.evil; index < teamCounts.evil; index += 1) {
    finalizedRoles.push("minion");
  }

  if (finalizedRoles.length !== playerCount) {
    return { message: `Expected exactly ${playerCount} roles after filling the remaining slots.`, ok: false };
  }

  return { ok: true, roles: finalizedRoles };
}

export function assignRolesToRoster(
  roster: RosterEntry[],
  selectedRoles: Role[]
): RoleAssignmentInput[] {
  const roles = [...selectedRoles];
  shuffleInPlace(roles);

  return roster.map((player, index) => ({
    displayName: player.displayName,
    role: roles[index],
    seatIndex: player.seatIndex,
    team: teamForRole(roles[index]),
    userId: player.userId
  }));
}

function isKnownToMerlin(role: Role): boolean {
  return role === "assassin" || role === "morgana" || role === "oberon" || role === "minion";
}

function visiblePlayersForPlayer(
  viewer: RoleAssignmentInput,
  assignments: RoleAssignmentInput[]
): ViewerVisiblePlayer[] {
  switch (viewer.role) {
    case "merlin":
      return assignments
        .filter((assignment) => assignment.userId !== viewer.userId && isKnownToMerlin(assignment.role))
        .map((assignment) => ({
          displayName: assignment.displayName,
          reason: "known-evil" as const,
          userId: assignment.userId
        }));
    case "percival":
      return assignments
        .filter((assignment) => assignment.userId !== viewer.userId && (assignment.role === "merlin" || assignment.role === "morgana"))
        .map((assignment) => ({
          displayName: assignment.displayName,
          reason: "merlin-or-morgana" as const,
          userId: assignment.userId
        }));
    case "assassin":
    case "morgana":
    case "mordred":
    case "minion":
      return assignments
        .filter(
          (assignment) =>
            assignment.userId !== viewer.userId &&
            assignment.team === "evil" &&
            assignment.role !== "oberon"
        )
        .map((assignment) => ({
          displayName: assignment.displayName,
          reason: "known-teammate" as const,
          userId: assignment.userId
        }));
    default:
      return [];
  }
}

export function buildViewerSecretState(
  viewerUserId: string,
  viewerRole: "member" | "spectator",
  assignments: RoleAssignmentInput[]
): ViewerSecretState | null {
  if (assignments.length === 0) {
    return null;
  }

  if (viewerRole === "spectator") {
    return {
      revealMode: "press-and-hold",
      role: null,
      team: null,
      viewerRole: "spectator",
      visiblePlayers: assignments.map((assignment) => ({
        displayName: assignment.displayName,
        reason: "all-roles-visible-to-spectator",
        role: assignment.role,
        team: assignment.team,
        userId: assignment.userId
      }))
    };
  }

  const viewer = assignments.find((assignment) => assignment.userId === viewerUserId);
  if (!viewer) {
    return null;
  }

  return {
    revealMode: "press-and-hold",
    role: viewer.role,
    team: viewer.team,
    viewerRole: "player",
    visiblePlayers: visiblePlayersForPlayer(viewer, assignments)
  };
}
