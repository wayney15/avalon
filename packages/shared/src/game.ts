export type Team = "good" | "evil";
export type QuestVote = "success" | "fail";
export type TeamVote = "approve" | "reject";

export type GameStatus =
  | "lobby"
  | "night"
  | "proposal"
  | "team-vote"
  | "quest-vote"
  | "assassination"
  | "finished"
  | "unfinished";

export type Role =
  | "merlin"
  | "percival"
  | "loyal-servant"
  | "assassin"
  | "morgana"
  | "mordred"
  | "oberon"
  | "minion";

export interface RoleAssignment {
  userId: string;
  role: Role;
  team: Team;
}

export interface ViewerVisiblePlayer {
  userId: string;
  displayName: string;
  role?: Role;
  team?: Team;
  reason:
    | "known-evil"
    | "merlin-or-morgana"
    | "known-teammate"
    | "all-roles-visible-to-spectator";
}

export interface PlayerViewerSecretState {
  viewerRole: "player";
  role: Role;
  team: Team;
  visiblePlayers: ViewerVisiblePlayer[];
  revealMode: "press-and-hold";
}

export interface SpectatorViewerSecretState {
  viewerRole: "spectator";
  role: null;
  team: null;
  visiblePlayers: ViewerVisiblePlayer[];
  revealMode: "press-and-hold";
}

export type ViewerSecretState = PlayerViewerSecretState | SpectatorViewerSecretState;

export interface RejectTracker {
  round: number;
  consecutiveRejects: number;
  limit: number;
}

export interface RoundTracker {
  round: number;
  attempt: number;
  leaderUserId: string;
}

export interface ActiveGameView {
  id: string;
  status: GameStatus;
  round: number;
  attempt: number;
  leaderUserId: string;
  rejectTracker: number;
  missionSize: number | null;
  proposedTeamUserIds: string[] | null;
  teamVotesSubmitted: number | null;
  assassination: {
    assassinUserId: string;
    candidateUserIds: string[];
  } | null;
  missionScores: {
    good: number;
    evil: number;
  };
}

export interface MissionResult {
  round: number;
  missionSize: number;
  successCount: number;
  failCount: number;
  winner: Team;
}

export interface ProposalRecord {
  round: number;
  attempt: number;
  leaderUserId: string;
  teamUserIds: string[];
}

export interface TeamVoteRecord {
  userId: string;
  vote: TeamVote;
}

export interface AssassinationRecord {
  assassinUserId: string;
  targetUserId: string;
  hitMerlin: boolean;
}

export interface GameSummary {
  id: string;
  roomId: string;
  status: Exclude<GameStatus, "lobby">;
  startedAt: string;
  endedAt: string | null;
  winner: Team | null;
}

export interface RoleVisibilityPayload {
  viewerRole: "player" | "spectator";
  role: Role | null;
  team: Team | null;
  visiblePlayers: ViewerVisiblePlayer[];
  revealMode: "press-and-hold";
}

export interface GameEventEnvelope<TType extends string, TPayload> {
  type: TType;
  occurredAt: string;
  payload: TPayload;
}

export interface ReplayEvent<TPayload = unknown> {
  id: string;
  gameId: string;
  sequenceNo: number;
  eventType: string;
  actorUserId: string | null;
  visibleTo: "all" | "host" | "evil" | "good" | "self" | "spectators" | "system";
  subjectUserId: string | null;
  payload: TPayload;
  createdAt: string;
}

export interface GameReplayResponse {
  game: GameSummary;
  events: ReplayEvent[];
}
