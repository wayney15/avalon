import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveGameView,
  AuthErrorResponse,
  AuthSession,
  AuthUser,
  CreateRoomResponse,
  GameReplayResponse,
  GameSummary,
  JoinRoomResponse,
  QuestVote,
  RecentRoomResponse,
  Role,
  RoomClientEvent,
  RoomDetailResponse,
  RoomServerEvent,
  RoomSnapshotEventPayload,
  RoomSummary,
  TeamVote,
  UserHistoryGameSummary,
  UserHistoryResponse,
  ViewerSecretState
} from "../../../packages/shared/src";

type AuthMode = "login" | "signup";
type SocketStatus = "offline" | "connecting" | "connected";
type RoleChoice = "merlin" | "percival" | "assassin" | "morgana" | "mordred" | "oberon";

interface AuthFormState {
  username: string;
  displayName: string;
  password: string;
}

interface JoinFormState {
  roomCode: string;
  inviteToken: string;
  asSpectator: boolean;
}

interface RoomFormsState {
  roomName: string;
  selectedRoles: RoleChoice[];
  selectedTeamUserIds: string[];
  selectedAssassinationTarget: string;
  seatSwapLeft: string;
  seatSwapRight: string;
}

interface ReplayState {
  gameId: string | null;
  data: GameReplayResponse | null;
  loading: boolean;
  error: string | null;
}

interface LiveActivityItem {
  id: string;
  occurredAt: string;
  message: string;
}

interface ReplayEntry {
  id: string;
  message: string;
}

const API_BASE = resolveApiBase();
const SESSION_STORAGE_KEY = "avalon.session";
const LAST_ROOM_STORAGE_KEY = "avalon.last-room-id";
const ROLE_OPTIONS: Array<{ label: string; value: RoleChoice }> = [
  { label: "莫德雷德", value: "mordred" },
  { label: "奥伯伦", value: "oberon" }
];
const MANDATORY_ROLES: RoleChoice[] = ["merlin", "percival", "assassin", "morgana"];

function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  return window.location.origin.replace(/\/$/, "");
}

function parseInviteTokenFromPath(pathname: string): string {
  const match = pathname.match(/^\/rooms\/invite\/([^/]+)$/);
  return match?.[1] ?? "";
}

function saveSession(session: AuthSession | null): void {
  if (!session) {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function loadSession(): AuthSession | null {
  const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    return null;
  }
}

function saveLastRoomId(roomId: string | null): void {
  if (!roomId) {
    window.localStorage.removeItem(LAST_ROOM_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(LAST_ROOM_STORAGE_KEY, roomId);
}

function loadLastRoomId(): string | null {
  return window.localStorage.getItem(LAST_ROOM_STORAGE_KEY);
}

function wsUrlForRoom(roomId: string, token: string): string {
  const url = new URL(`/api/rooms/${roomId}/ws`, API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

async function requestJson<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");

  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers
  });

  const text = await response.text();
  const data = text.length > 0 ? (JSON.parse(text) as T | AuthErrorResponse) : null;

  if (!response.ok) {
    const message =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message
        : `Request failed with status ${response.status}.`;
    throw new Error(message);
  }

  return data as T;
}

function inferViewerPresenceRole(snapshot: RoomSnapshotEventPayload | null, userId: string): "host" | "player" | "spectator" | null {
  if (!snapshot) {
    return null;
  }

  const player = snapshot.players.find((entry) => entry.userId === userId);
  if (player) {
    return player.role;
  }

  return snapshot.spectators.some((entry) => entry.userId === userId) ? "spectator" : null;
}

function summarizeRoomEvent(
  event: RoomServerEvent,
  resolveName: (userId: string) => string
): string | null {
  switch (event.type) {
    case "room.host.updated":
      return `${resolveName(event.payload.hostUserId)} is now host.`;
    case "room.locked":
      return "Room locked for an active game.";
    case "room.unlocked":
      return "Room returned to lobby state.";
    case "game.team.proposed":
      return `${resolveName(event.payload.leaderUserId)} proposed ${event.payload.teamUserIds.map(resolveName).join(", ")}.`;
    case "game.team.vote.revealed":
      return event.payload.approved
        ? `Team approved on round ${event.payload.round}.`
        : `Team rejected. Reject track is ${event.payload.rejectTracker}.`;
    case "game.quest.result.revealed":
      return `Quest ${event.payload.round} ${event.payload.winner === "good" ? "succeeded" : "failed"} with ${event.payload.failCount} fail card${event.payload.failCount === 1 ? "" : "s"}.`;
    case "game.paused":
      return `${resolveName(event.payload.disconnectedUserId)} disconnected. Game paused.`;
    case "game.resumed":
      return "All required players returned. Game resumed.";
    case "game.assassination.started":
      return `${resolveName(event.payload.assassinUserId)} is choosing an assassination target.`;
    case "game.finished":
      return gameResultNotice(event.payload.winner);
    case "game.terminated":
      return event.payload.reason === "host_ended_game"
        ? "Host ended the current game."
        : "Game terminated after a host force-remove.";
    case "history.game.available":
      return "A completed game was added to room history.";
    case "error":
      return event.payload.message;
    default:
      return null;
  }
}

function roleLabel(role: Role): string {
  switch (role) {
    case "merlin":
      return "梅林";
    case "percival":
      return "派西维尔";
    case "loyal-servant":
      return "忠臣";
    case "assassin":
      return "刺客";
    case "morgana":
      return "莫甘娜";
    case "mordred":
      return "莫德雷德";
    case "oberon":
      return "奥伯伦";
    case "minion":
      return "爪牙";
    default:
      return role;
  }
}

function presenceRoleLabel(role: "host" | "player" | "spectator"): string {
  switch (role) {
    case "host":
      return "房主";
    case "player":
      return "玩家";
    case "spectator":
      return "观战";
    default:
      return role;
  }
}

function teamLabel(secretState: ViewerSecretState | null): string {
  if (!secretState || !secretState.team) {
    return "观战";
  }

  return secretState.team === "good" ? "Good" : "Evil";
}

function missionTrack(results: Array<"success" | "fail">): string {
  return Array.from({ length: 5 }, (_, index) => {
    const result = results[index];
    if (result === "success") {
      return "✓";
    }
    if (result === "fail") {
      return "✗";
    }
    return "-";
  }).join(" ");
}

function formatTeamVoteBreakdown(
  votes: Array<{ userId: string; vote: TeamVote }>,
  resolveName: (userId: string) => string
): string {
  const approvedBy = votes.filter((entry) => entry.vote === "approve").map((entry) => resolveName(entry.userId));
  const rejectedBy = votes.filter((entry) => entry.vote === "reject").map((entry) => resolveName(entry.userId));
  return `Approved: ${approvedBy.join(", ") || "none"}. Rejected: ${rejectedBy.join(", ") || "none"}.`;
}

function buildReplayEntries(
  replayData: GameReplayResponse,
  resolveName: (userId: string) => string
): ReplayEntry[] {
  const entries: ReplayEntry[] = [];
  let lastProposal:
    | {
        leaderUserId: string;
        round: number;
        teamUserIds: string[];
      }
    | null = null;
  let lastVote:
    | {
        leaderUserId: string;
        round: number;
        teamUserIds: string[];
        votes: Array<{ userId: string; vote: TeamVote }>;
      }
    | null = null;

  for (const event of replayData.events) {
    if (event.eventType === "team.proposed") {
      const payload = event.payload as {
        leaderUserId: string;
        round: number;
        teamUserIds: string[];
      };
      lastProposal = payload;
      entries.push({
        id: event.id,
        message: `Leader ${resolveName(payload.leaderUserId)} proposed ${payload.teamUserIds.map(resolveName).join(", ")}.`
      });
      continue;
    }

    if (event.eventType === "team.vote.revealed") {
      const payload = event.payload as {
        approved: boolean;
        round: number;
        votes: Array<{ userId: string; vote: TeamVote }>;
      };
      if (lastProposal && lastProposal.round === payload.round) {
        lastVote = {
          leaderUserId: lastProposal.leaderUserId,
          round: lastProposal.round,
          teamUserIds: lastProposal.teamUserIds,
          votes: payload.votes
        };
      }

      if (!payload.approved && lastProposal && lastProposal.round === payload.round) {
        entries.push({
          id: event.id,
          message: `Leader ${resolveName(lastProposal.leaderUserId)}'s team was rejected. ${formatTeamVoteBreakdown(payload.votes, resolveName)}`
        });
      }
      continue;
    }

    if (event.eventType === "quest.result.revealed") {
      const payload = event.payload as {
        failCount: number;
        round: number;
        winner: "good" | "evil";
      };
      const leaderUserId = lastVote?.round === payload.round ? lastVote.leaderUserId : lastProposal?.leaderUserId;
      const teamUserIds = lastVote?.round === payload.round ? lastVote.teamUserIds : lastProposal?.teamUserIds ?? [];
      const voteBreakdown =
        lastVote?.round === payload.round ? ` ${formatTeamVoteBreakdown(lastVote.votes, resolveName)}` : "";
      entries.push({
        id: event.id,
        message: `Leader ${leaderUserId ? resolveName(leaderUserId) : "unknown"} sent ${teamUserIds.map(resolveName).join(", ")}. Quest ${payload.round} ${payload.winner === "good" ? "succeeded" : "failed"} with ${payload.failCount} fail card${payload.failCount === 1 ? "" : "s"}.${voteBreakdown}`
      });
      continue;
    }

    if (event.eventType === "game.finished") {
      const payload = event.payload as { winner: "good" | "evil" | null };
      entries.push({
        id: event.id,
        message: gameResultNotice(payload.winner)
      });
    }
  }

  return entries;
}

function withRoomVisibility(
  current: RoomSnapshotEventPayload,
  visibility: "open" | "locked"
): RoomSnapshotEventPayload {
  return {
    ...current,
    lockStatus: visibility,
    room: {
      ...current.room,
      visibility
    }
  };
}

function withActiveGame(
  current: RoomSnapshotEventPayload,
  transform: (game: ActiveGameView | null) => ActiveGameView | null
): RoomSnapshotEventPayload {
  return {
    ...current,
    activeGame: transform(current.activeGame)
  };
}

function gameResultNotice(winner: "good" | "evil" | null): string {
  if (winner === "good") {
    return "Game finished. Good wins.";
  }

  if (winner === "evil") {
    return "Game finished. Evil wins.";
  }

  return "Game finished.";
}

export function App() {
  const inviteTokenFromPath = useMemo(() => parseInviteTokenFromPath(window.location.pathname), []);
  const socketRef = useRef<WebSocket | null>(null);
  const playerLookupRef = useRef<Map<string, string>>(new Map());
  const reconnectTimerRef = useRef<number | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [session, setSession] = useState<AuthSession | null>(() => loadSession());
  const [activeRoom, setActiveRoom] = useState<RoomSummary | null>(null);
  const [snapshot, setSnapshot] = useState<RoomSnapshotEventPayload | null>(null);
  const [historyGames, setHistoryGames] = useState<UserHistoryGameSummary[]>([]);
  const [historySelectionOpen, setHistorySelectionOpen] = useState(false);
  const [historySelectionLoading, setHistorySelectionLoading] = useState(false);
  const [replay, setReplay] = useState<ReplayState>({ data: null, error: null, gameId: null, loading: false });
  const [authForm, setAuthForm] = useState<AuthFormState>({ displayName: "", password: "", username: "" });
  const [joinForm, setJoinForm] = useState<JoinFormState>({
    asSpectator: false,
    inviteToken: inviteTokenFromPath,
    roomCode: ""
  });
  const [roomForms, setRoomForms] = useState<RoomFormsState>({
    roomName: "",
    seatSwapLeft: "",
    seatSwapRight: "",
    selectedAssassinationTarget: "",
    selectedRoles: [],
    selectedTeamUserIds: []
  });
  const [screenError, setScreenError] = useState<string | null>(null);
  const [screenNotice, setScreenNotice] = useState<string | null>(null);
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("offline");
  const [lastEvent, setLastEvent] = useState<RoomServerEvent | null>(null);
  const [liveActivity, setLiveActivity] = useState<LiveActivityItem[]>([]);
  const [isSecretRevealActive, setIsSecretRevealActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [submittedTeamVote, setSubmittedTeamVote] = useState<TeamVote | null>(null);
  const [submittedQuestVote, setSubmittedQuestVote] = useState(false);
  const [socketReconnectNonce, setSocketReconnectNonce] = useState(0);

  const viewerRole = inferViewerPresenceRole(snapshot, session?.user.id ?? "");
  const isHost = viewerRole === "host";
  const isPlayer = viewerRole === "host" || viewerRole === "player";
  const activeGame = snapshot?.activeGame ?? null;
  const currentUserId = session?.user.id ?? "";
  const players = snapshot?.players ?? [];
  const seatedPlayers = snapshot?.seats ?? [];
  const playerLookup = useMemo(
    () => new Map(players.map((entry) => [entry.userId, entry.displayName])),
    [players]
  );
  const disconnectedPlayers = useMemo(
    () => players.filter((player) => !player.connected),
    [players]
  );
  const proposedTeam = useMemo(
    () =>
      activeGame?.proposedTeamUserIds?.map((userId) => ({
        userId,
        displayName: playerLookup.get(userId) ?? userId
      })) ?? [],
    [activeGame?.proposedTeamUserIds, playerLookup]
  );
  const pendingTeamVoters = useMemo(
    () => activeGame?.pendingTeamVoteUserIds?.map((userId) => playerLookup.get(userId) ?? userId) ?? [],
    [activeGame?.pendingTeamVoteUserIds, playerLookup]
  );
  const replayPlayerLookup = useMemo(
    () => new Map((replay.data?.players ?? []).map((player) => [player.userId, player.displayName])),
    [replay.data?.players]
  );
  const replayEntries = useMemo(
    () =>
      replay.data
        ? buildReplayEntries(replay.data, (userId) => replayPlayerLookup.get(userId) ?? playerLookup.get(userId) ?? userId)
        : [],
    [playerLookup, replay.data, replayPlayerLookup]
  );
  const canSubmitTeamVote =
    Boolean(activeGame) && activeGame?.status === "team-vote" && isPlayer;
  const canSubmitQuestVote =
    Boolean(activeGame) &&
    activeGame?.status === "quest-vote" &&
    isPlayer &&
    activeGame.proposedTeamUserIds?.includes(currentUserId) === true;
  const canSubmitAssassination =
    Boolean(activeGame) &&
    activeGame?.status === "assassination" &&
    snapshot?.viewerSecretState?.viewerRole === "player" &&
    snapshot.viewerSecretState.role === "assassin";
  const gamePaused = Boolean(activeGame) && disconnectedPlayers.length > 0;

  useEffect(() => {
    playerLookupRef.current = playerLookup;
  }, [playerLookup]);

  useEffect(() => {
    if (!session) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      setActiveRoom(null);
      setSnapshot(null);
      setHistoryGames([]);
      setHistorySelectionOpen(false);
      setHistorySelectionLoading(false);
      setReplay({ data: null, error: null, gameId: null, loading: false });
      setLiveActivity([]);
      saveSession(null);
      saveLastRoomId(null);
      return;
    }

    saveSession(session);
  }, [session]);

  useEffect(() => {
    if (!session) {
      return;
    }

    let cancelled = false;
    requestJson<{ user: AuthUser }>("/api/auth/me", { method: "GET" }, session.token)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setSession((current) => (current ? { ...current, user: response.user } : current));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        setSession(null);
        setScreenError("Your session is no longer valid. Sign in again.");
      });

    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  useEffect(() => {
    if (!session || activeRoom) {
      return;
    }

    void restoreRoomSession({ silent: true });
  }, [activeRoom, inviteTokenFromPath, session]);

  useEffect(() => {
    if (!activeRoom || !session) {
      return;
    }

    let cancelled = false;
    requestJson<RoomDetailResponse>(`/api/rooms/${activeRoom.id}`, { method: "GET" }, session.token)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setLastInviteUrl(response.inviteUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setLastInviteUrl(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeRoom?.id, session]);

  useEffect(() => {
    if (!activeRoom || !session) {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      socketRef.current?.close();
      socketRef.current = null;
      setSocketStatus("offline");
      setSnapshot(null);
      setLiveActivity([]);
      return;
    }

    setLiveActivity([]);
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    let cancelled = false;
    const socket = new WebSocket(wsUrlForRoom(activeRoom.id, session.token));
    socketRef.current = socket;
    setSocketStatus("connecting");

    socket.addEventListener("open", () => {
      setSocketStatus("connected");
      sendRoomEvent(socket, { payload: { roomId: activeRoom.id }, type: "room.connect" });
    });

    socket.addEventListener("message", (message) => {
      const parsed = JSON.parse(String(message.data)) as RoomServerEvent;
      setLastEvent(parsed);
      const summary = summarizeRoomEvent(parsed, (userId) => playerLookupRef.current.get(userId) ?? userId);
      if (summary) {
        setLiveActivity((current) => [
          {
            id: `${parsed.type}-${parsed.occurredAt}-${current.length}`,
            message: summary,
            occurredAt: parsed.occurredAt
          },
          ...current
        ].slice(0, 12));
      }

      if (parsed.type === "room.snapshot") {
        setSnapshot(parsed.payload);
        syncRoomSummaryFromSnapshot(parsed.payload);
        if (parsed.payload.activeGame?.status !== "assassination") {
          setRoomForms((current) => ({ ...current, selectedAssassinationTarget: "" }));
        }
        return;
      }

      if (parsed.type === "room.presence.updated") {
        updateSnapshotState((current) => ({
          ...current,
          players: parsed.payload.players,
          spectators: parsed.payload.spectators
        }));
        return;
      }

      if (parsed.type === "room.seating.updated") {
        updateSnapshotState((current) => ({
          ...current,
          seats: parsed.payload.seats
        }));
        return;
      }

      if (parsed.type === "room.host.updated") {
        updateSnapshotState((current) => ({
          ...current,
          players: current.players.map((player) => ({
            ...player,
            role: player.userId === parsed.payload.hostUserId ? "host" : "player"
          })),
          room: {
            ...current.room,
            hostId: parsed.payload.hostUserId
          }
        }));
        return;
      }

      if (parsed.type === "game.phase.changed") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  assassination: parsed.payload.phase === "assassination" ? game.assassination : null,
                  attempt: parsed.payload.attempt,
                  leaderUserId: parsed.payload.leaderUserId,
                  pendingTeamVoteUserIds: parsed.payload.phase === "team-vote" ? game.pendingTeamVoteUserIds : null,
                  proposedTeamUserIds:
                    parsed.payload.phase === "proposal" ? null : game.proposedTeamUserIds,
                  round: parsed.payload.round,
                  status: parsed.payload.phase,
                  teamVotesSubmitted: parsed.payload.phase === "team-vote" ? 0 : null
                }
              : game
          )
        );
        return;
      }

      if (parsed.type === "game.team.proposed") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  attempt: parsed.payload.attempt,
                  leaderUserId: parsed.payload.leaderUserId,
                  pendingTeamVoteUserIds: current.players.map((player) => player.userId),
                  proposedTeamUserIds: parsed.payload.teamUserIds,
                  round: parsed.payload.round,
                  teamVotesSubmitted: 0
                }
              : game
          )
        );
        return;
      }

      if (parsed.type === "game.team.vote.revealed") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  attempt: parsed.payload.attempt,
                  pendingTeamVoteUserIds: null,
                  rejectTracker: parsed.payload.rejectTracker,
                  round: parsed.payload.round,
                  teamVotesSubmitted: null
                }
              : game
          )
        );
        setScreenNotice(
          parsed.payload.approved
            ? "Team approved. Quest voting is open."
            : `Team rejected. Reject track is now ${parsed.payload.rejectTracker}.`
        );
        return;
      }

      if (parsed.type === "game.quest.result.revealed") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  missionResults: [
                    ...game.missionResults,
                    parsed.payload.winner === "good" ? "success" : "fail"
                  ],
                  missionScores: parsed.payload.score,
                  pendingTeamVoteUserIds: null,
                  proposedTeamUserIds: null
                }
              : game
          )
        );
        setScreenNotice(
          `Quest ${parsed.payload.round} ${parsed.payload.winner === "good" ? "succeeded" : "failed"} (${parsed.payload.successCount} success, ${parsed.payload.failCount} fail).`
        );
        return;
      }

      if (parsed.type === "game.paused") {
        setScreenNotice(`${playerLookup.get(parsed.payload.disconnectedUserId) ?? "A player"} disconnected. Game paused.`);
        return;
      }

      if (parsed.type === "game.resumed") {
        setScreenNotice("All required players are back. Game resumed.");
        return;
      }

      if (parsed.type === "game.assassination.started") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  assassination: {
                    assassinUserId: parsed.payload.assassinUserId,
                    candidateUserIds: parsed.payload.candidateUserIds
                  },
                  status: "assassination"
                }
              : game
          )
        );
        setScreenNotice("Assassination phase started.");
        return;
      }

      if (parsed.type === "game.finished") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  status: "finished"
                }
              : game
          )
        );
        setScreenNotice(gameResultNotice(parsed.payload.winner));
        return;
      }

      if (parsed.type === "game.terminated") {
        updateSnapshotState((current) =>
          withActiveGame(current, (game) =>
            game && game.id === parsed.payload.gameId
              ? {
                  ...game,
                  status: "unfinished"
                }
              : game
          )
        );
        setScreenNotice(
          parsed.payload.reason === "host_ended_game"
            ? "The host ended the current game."
            : "Game terminated after the host force-removed a disconnected player."
        );
        return;
      }

      if (parsed.type === "history.game.available") {
        return;
      }

      if (parsed.type === "error") {
        setScreenError(parsed.payload.message);
        return;
      }

      if (parsed.type === "room.locked" || parsed.type === "room.unlocked") {
        updateSnapshotState((current) =>
          withRoomVisibility(current, parsed.type === "room.locked" ? "locked" : "open")
        );
        setActiveRoom((current) =>
          current
            ? {
                ...current,
                hasActiveGame: parsed.type === "room.locked",
                visibility: parsed.type === "room.locked" ? "locked" : "open"
              }
            : current
        );
      }
    });

    socket.addEventListener("close", () => {
      if (cancelled) {
        return;
      }
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
      setSocketStatus("offline");

      if (reconnectTimerRef.current === null) {
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null;
          setSocketReconnectNonce((current) => current + 1);
        }, 1000);
      }
    });

    socket.addEventListener("error", () => {
      setScreenError("The room connection failed.");
    });

    saveLastRoomId(activeRoom.id);

    return () => {
      cancelled = true;
      socket.close();
      if (socketRef.current === socket) {
        socketRef.current = null;
      }
    };
  }, [activeRoom?.id, session?.token, socketReconnectNonce]);

  useEffect(() => {
    if (!activeGame) {
      setRoomForms((current) => ({
        ...current,
        selectedAssassinationTarget: "",
        selectedTeamUserIds: []
      }));
      return;
    }

    setRoomForms((current) => {
      const nextTeamSelection = current.selectedTeamUserIds.filter((userId) =>
        players.some((player) => player.userId === userId)
      );
      const nextTarget =
        current.selectedAssassinationTarget &&
        activeGame.assassination?.candidateUserIds.includes(current.selectedAssassinationTarget)
          ? current.selectedAssassinationTarget
          : "";
      return {
        ...current,
        selectedAssassinationTarget: nextTarget,
        selectedTeamUserIds: nextTeamSelection
      };
    });
  }, [activeGame, players]);

  function syncRoomSummaryFromSnapshot(nextSnapshot: RoomSnapshotEventPayload): void {
    setActiveRoom((current) =>
      current
        ? {
            ...current,
            code: nextSnapshot.room.code,
            hasActiveGame: nextSnapshot.activeGame !== null,
            hostId: nextSnapshot.room.hostId,
            name: nextSnapshot.room.name,
            playerCount: nextSnapshot.players.length,
            spectatorCount: nextSnapshot.spectators.length,
            visibility: nextSnapshot.lockStatus
          }
        : current
    );
  }

  function updateSnapshotState(
    transform: (current: RoomSnapshotEventPayload) => RoomSnapshotEventPayload
  ): void {
    setSnapshot((current) => {
      if (!current) {
        return current;
      }

      const next = transform(current);
      syncRoomSummaryFromSnapshot(next);
      return next;
    });
  }

  async function openHistorySelection(): Promise<void> {
    if (!session) {
      return;
    }

    setHistorySelectionOpen(true);
    setHistorySelectionLoading(true);
    setReplay({ data: null, error: null, gameId: null, loading: false });

    try {
      const response = await requestJson<UserHistoryResponse>("/api/history/games", { method: "GET" }, session.token);
      setHistoryGames(response.games);
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Unable to load your game history.");
    } finally {
      setHistorySelectionLoading(false);
    }
  }

  async function fetchReplay(gameId: string): Promise<void> {
    if (!session) {
      return;
    }

    setReplay({ data: null, error: null, gameId, loading: true });
    try {
      const data = await requestJson<GameReplayResponse>(`/api/games/${gameId}`, { method: "GET" }, session.token);
      setReplay({ data, error: null, gameId, loading: false });
      setHistorySelectionOpen(false);
    } catch (error) {
      setReplay({
        data: null,
        error: error instanceof Error ? error.message : "Unable to load replay.",
        gameId,
        loading: false
      });
    }
  }

  function clearFeedback(): void {
    setScreenError(null);
    setScreenNotice(null);
  }

  async function restoreRoomSession(options?: { silent?: boolean }): Promise<boolean> {
    if (!session || activeRoom) {
      return false;
    }

    const inviteToken = inviteTokenFromPath;
    const lastRoomId = loadLastRoomId();

    if (inviteToken) {
      try {
        const response = await requestJson<JoinRoomResponse>(
          "/api/rooms/join",
          {
            body: JSON.stringify({ inviteToken }),
            method: "POST"
          },
          session.token
        );
        setActiveRoom(response.room);
        setLastInviteUrl(new URL(`/rooms/invite/${inviteToken}`, window.location.origin).toString());
        return true;
      } catch {
        // Fall through to stored room recovery.
      }
    }

    if (lastRoomId) {
      try {
        const response = await requestJson<RoomDetailResponse>(`/api/rooms/${lastRoomId}`, { method: "GET" }, session.token);
        setActiveRoom(response.room);
        setLastInviteUrl(response.inviteUrl);
        return true;
      } catch {
        saveLastRoomId(null);
      }
    }

    try {
      const response = await requestJson<RecentRoomResponse>("/api/rooms/recent", { method: "GET" }, session.token);
      if (response.room) {
        setActiveRoom(response.room);
        return true;
      }
    } catch {
      // Ignore here and handle below.
    }

    if (!options?.silent) {
      setScreenError("No room was found to rejoin.");
    }

    return false;
  }

  async function handleAuthSubmit(): Promise<void> {
    clearFeedback();
    setIsBusy(true);

    const path = authMode === "signup" ? "/api/auth/signup" : "/api/auth/login";
    const body =
      authMode === "signup"
        ? JSON.stringify(authForm)
        : JSON.stringify({ password: authForm.password, username: authForm.username });

    try {
      const nextSession = await requestJson<AuthSession>(path, { body, method: "POST" });
      setSession(nextSession);
      setAuthForm({ displayName: "", password: "", username: "" });
      setScreenNotice(authMode === "signup" ? "Account created." : "Signed in.");
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Authentication failed.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleCreateRoom(): Promise<void> {
    if (!session) {
      return;
    }

    clearFeedback();
    setIsBusy(true);

    try {
      const response = await requestJson<CreateRoomResponse>(
        "/api/rooms",
        {
          body: JSON.stringify({ name: roomForms.roomName }),
          method: "POST"
        },
        session.token
      );
      setActiveRoom(response.room);
      setLastInviteUrl(response.inviteUrl);
      setRoomForms((current) => ({ ...current, roomName: "" }));
      setScreenNotice(`Room created. Invite link: ${response.inviteUrl}`);
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Unable to create room.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleJoinRoom(): Promise<void> {
    if (!session) {
      return;
    }

    clearFeedback();
    setIsBusy(true);

    try {
      const response = await requestJson<JoinRoomResponse>(
        "/api/rooms/join",
        {
          body: JSON.stringify({
            asSpectator: joinForm.asSpectator,
            inviteToken: joinForm.inviteToken || undefined,
            roomCode: joinForm.roomCode || undefined
          }),
          method: "POST"
        },
        session.token
      );
      setActiveRoom(response.room);
      if (joinForm.inviteToken) {
        setLastInviteUrl(new URL(`/rooms/invite/${joinForm.inviteToken}`, window.location.origin).toString());
      } else {
        setLastInviteUrl(null);
      }
      setScreenNotice(joinForm.asSpectator ? "Joined as spectator." : "Joined room.");
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "Unable to join room.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleRejoinRoom(): Promise<void> {
    clearFeedback();
    setIsBusy(true);

    try {
      const rejoined = await restoreRoomSession();
      if (rejoined) {
        setScreenNotice("Rejoined room.");
      }
    } finally {
      setIsBusy(false);
    }
  }

  function sendEvent(event: RoomClientEvent): boolean {
    clearFeedback();
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setScreenError("The live room connection is not open.");
      return false;
    }

    sendRoomEvent(socket, event);
    return true;
  }

  async function handleLeaveRoom(): Promise<void> {
    sendEvent({ payload: { roomId: activeRoom?.id ?? "" }, type: "room.leave" });
    socketRef.current?.close();
    socketRef.current = null;
    setActiveRoom(null);
    setSnapshot(null);
    setHistorySelectionOpen(false);
    setReplay({ data: null, error: null, gameId: null, loading: false });
    setLiveActivity([]);
    setLastInviteUrl(null);
    saveLastRoomId(null);
  }

  function toggleOptionalRole(value: RoleChoice): void {
    setRoomForms((current) => ({
      ...current,
      selectedRoles: current.selectedRoles.includes(value)
        ? current.selectedRoles.filter((entry) => entry !== value)
        : [...current.selectedRoles, value]
    }));
  }

  function startGame(): void {
    const roles: Role[] = [...MANDATORY_ROLES, ...(players.length >= 7 ? roomForms.selectedRoles : [])];
    sendEvent({ payload: { roles }, type: "room.start-game" });
  }

  function endGame(): void {
    if (!activeRoom) {
      return;
    }

    if (!window.confirm("End the current game and return the room to the lobby?")) {
      return;
    }

    sendEvent({ payload: { roomId: activeRoom.id }, type: "room.end-game" });
  }

  function toggleTeamMember(userId: string): void {
    setRoomForms((current) => ({
      ...current,
      selectedTeamUserIds: current.selectedTeamUserIds.includes(userId)
        ? current.selectedTeamUserIds.filter((entry) => entry !== userId)
        : [...current.selectedTeamUserIds, userId]
    }));
  }

  function submitTeamProposal(): void {
    if (!activeGame) {
      return;
    }

    sendEvent({
      payload: {
        gameId: activeGame.id,
        teamUserIds: roomForms.selectedTeamUserIds
      },
      type: "game.propose-team"
    });
  }

  function submitTeamVote(vote: TeamVote): void {
    if (!activeGame) {
      return;
    }

    if (!sendEvent({
      payload: {
        gameId: activeGame.id,
        vote
      },
      type: "game.submit-team-vote"
    })) {
      return;
    }

    setSubmittedTeamVote(vote);
  }

  function submitQuestVote(vote: QuestVote): void {
    if (!activeGame) {
      return;
    }

    if (!sendEvent({
      payload: {
        gameId: activeGame.id,
        vote
      },
      type: "game.submit-quest-vote"
    })) {
      return;
    }

    setSubmittedQuestVote(true);
  }

  function submitAssassination(): void {
    if (!activeGame || !roomForms.selectedAssassinationTarget) {
      return;
    }

    const targetName = playerLookup.get(roomForms.selectedAssassinationTarget) ?? "this player";
    if (!window.confirm(`Confirm assassination target: ${targetName}?`)) {
      return;
    }

    sendEvent({
      payload: {
        gameId: activeGame.id,
        targetUserId: roomForms.selectedAssassinationTarget
      },
      type: "game.submit-assassination"
    });
  }

  function joinAs(role: "player" | "spectator"): void {
    sendEvent({
      payload: { roomId: activeRoom?.id ?? "" },
      type: role === "player" ? "room.join-player" : "room.join-spectator"
    });
  }

  function kickOrForceRemove(targetUserId: string): void {
    sendEvent({ payload: { targetUserId }, type: "room.kick-player" });
  }

  function revealDisconnectedPlayer(targetUserId: string): void {
    sendEvent({ payload: { targetUserId }, type: "room.reveal-disconnected" });
  }

  function refreshSecretState(): void {
    if (!activeGame) {
      return;
    }

    sendEvent({
      payload: { gameId: activeGame.id },
      type: "game.request-role-reveal"
    });
  }

  function advanceToProposal(): void {
    if (!activeGame) {
      return;
    }

    sendEvent({
      payload: { gameId: activeGame.id },
      type: "game.advance-to-proposal"
    });
  }

  const proposalLeaderName = activeGame ? playerLookup.get(activeGame.leaderUserId) ?? activeGame.leaderUserId : null;
  const secretState = snapshot?.viewerSecretState ?? null;
  const canAdvanceNight =
    activeGame?.status === "night" &&
    isHost &&
    !gamePaused;
  const canProposeTeam =
    activeGame?.status === "proposal" &&
    activeGame.leaderUserId === currentUserId &&
    isPlayer &&
    !gamePaused;
  const missionSize = activeGame?.missionSize ?? 0;
  const teamVoteLocked = submittedTeamVote !== null || snapshot?.viewerActionState?.teamVoteSubmitted === true;
  const questVoteLocked = submittedQuestVote || snapshot?.viewerActionState?.questVoteSubmitted === true;

  useEffect(() => {
    setSubmittedTeamVote(null);
    setSubmittedQuestVote(false);
  }, [activeGame?.id, activeGame?.attempt, activeGame?.round, activeGame?.status]);

  return (
    <main className="app-shell">
      <section className="top-bar">
        <div className="top-bar-main">
          <div className="top-bar-status">
            <span className={`status-dot status-${socketStatus}`} />
            <strong>{session ? session.user.displayName : "Signed out"}</strong>
            <span className="top-bar-room">{activeRoom ? activeRoom.code : "No room"}</span>
          </div>
        </div>
      </section>

      {screenError ? <p className="banner banner-error">{screenError}</p> : null}
      {screenNotice ? <p className="banner banner-notice">{screenNotice}</p> : null}

      {!session ? (
        <section className="panel auth-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Authentication</p>
              <h2>{authMode === "signup" ? "Create account" : "Sign in"}</h2>
            </div>
            <div className="segmented">
              <button
                className={authMode === "login" ? "chip active" : "chip"}
                onClick={() => setAuthMode("login")}
                type="button"
              >
                Login
              </button>
              <button
                className={authMode === "signup" ? "chip active" : "chip"}
                onClick={() => setAuthMode("signup")}
                type="button"
              >
                Signup
              </button>
            </div>
          </div>

          <div className="form-grid">
            <label>
              <span>Username</span>
              <input
                autoComplete="username"
                onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="arthur_host"
                value={authForm.username}
              />
            </label>
            {authMode === "signup" ? (
              <label>
                <span>Display name</span>
                <input
                  autoComplete="nickname"
                  onChange={(event) => setAuthForm((current) => ({ ...current, displayName: event.target.value }))}
                  placeholder="Arthur"
                  value={authForm.displayName}
                />
              </label>
            ) : null}
            <label>
              <span>Password</span>
              <input
                autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="At least 8 characters"
                type="password"
                value={authForm.password}
              />
            </label>
          </div>

          <button disabled={isBusy} onClick={() => void handleAuthSubmit()} type="button">
            {authMode === "signup" ? "Create account" : "Sign in"}
          </button>
        </section>
      ) : (
        <>
          {!activeRoom ? (
            <section className="panel setup-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">Room access</p>
                  <h2>Create or join</h2>
                </div>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setSession(null);
                    clearFeedback();
                  }}
                  type="button"
                >
                  Sign out
                </button>
              </div>

              <div className="split-grid">
                <div className="card">
                  <h3>Create room</h3>
                  <label>
                    <span>Room name</span>
                    <input
                      onChange={(event) => setRoomForms((current) => ({ ...current, roomName: event.target.value }))}
                      placeholder="Friday Avalon"
                      value={roomForms.roomName}
                    />
                  </label>
                  <button disabled={isBusy} onClick={() => void handleCreateRoom()} type="button">
                    Create room
                  </button>
                </div>

                <div className="card">
                  <h3>Join room</h3>
                  <label>
                    <span>Room code</span>
                    <input
                      onChange={(event) => setJoinForm((current) => ({ ...current, roomCode: event.target.value.toUpperCase() }))}
                      placeholder="K7M4Q"
                      value={joinForm.roomCode}
                    />
                  </label>
                  <label>
                    <span>Invite token</span>
                    <input
                      onChange={(event) => setJoinForm((current) => ({ ...current, inviteToken: event.target.value }))}
                      placeholder="inv_..."
                      value={joinForm.inviteToken}
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      checked={joinForm.asSpectator}
                      onChange={(event) => setJoinForm((current) => ({ ...current, asSpectator: event.target.checked }))}
                      type="checkbox"
                    />
                    <span>Join as spectator</span>
                  </label>
                  <button disabled={isBusy} onClick={() => void handleJoinRoom()} type="button">
                    Join room
                  </button>
                  <button className="ghost-button" disabled={isBusy} onClick={() => void handleRejoinRoom()} type="button">
                    Rejoin
                  </button>
                </div>

                <div className="card">
                  <h3>History</h3>
                  {!replay.loading && !replay.error && !replay.data && !historySelectionOpen ? (
                    <>
                      <p className="small-copy">Review any finished game from your signed-in history.</p>
                      <button onClick={() => void openHistorySelection()} type="button">
                        Select game
                      </button>
                    </>
                  ) : null}
                  {historySelectionOpen ? (
                    <>
                      <p className="small-copy">Choose one of your finished games.</p>
                      <ul className="history-list">
                        {historySelectionLoading ? <li className="empty">Loading finished games.</li> : null}
                        {!historySelectionLoading && historyGames.length === 0 ? (
                          <li className="empty">No finished games found for your account.</li>
                        ) : null}
                        {historyGames.map((game) => (
                          <li key={game.id}>
                            <button
                              className={replay.gameId === game.id ? "history-button active" : "history-button"}
                              onClick={() => void fetchReplay(game.id)}
                              type="button"
                            >
                              <strong>{game.roomName}</strong>
                              <span>{game.roomCode} • {game.winner ? `${game.winner} wins` : "finished"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {replay.loading ? <p className="empty">Loading replay.</p> : null}
                  {replay.error ? <p className="banner banner-error">{replay.error}</p> : null}
                  {replay.data ? (
                    <>
                      <div className="replay-head">
                        <button onClick={() => void openHistorySelection()} type="button">
                          Select a new game
                        </button>
                        <p className="meta-line">
                          Winner {replay.data.game.winner ?? "none"} • {replayEntries.length} replay entries
                        </p>
                      </div>
                      <ul className="replay-list">
                        {replayEntries.map((entry) => (
                          <li key={entry.id}>
                            <strong>{entry.message}</strong>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          {activeRoom ? (
            <section className="workspace">
              <section className="panel room-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">Live room</p>
                    <h2>{activeRoom.name}</h2>
                    <p className="meta-line">
                      Code {activeRoom.code} • {snapshot?.room.visibility ?? activeRoom.visibility} • {socketStatus}
                    </p>
                  </div>
                  <div className="panel-actions">
                    <button className="ghost-button" onClick={() => void handleLeaveRoom()} type="button">
                      Close room view
                    </button>
                  </div>
                </div>

                {snapshot ? (
                  <>
                    <div className="summary-strip">
                      <div className="summary-item">
                        <span>Players</span>
                        <strong>{snapshot.players.length}</strong>
                      </div>
                      <div className="summary-item">
                        <span>Spectators</span>
                        <strong>{snapshot.spectators.length}</strong>
                      </div>
                      <div className="summary-item">
                        <span>Role</span>
                        <strong>{viewerRole ?? "viewer"}</strong>
                      </div>
                      <div className="summary-item">
                        <span>Invite</span>
                        <strong className="invite-line">{lastInviteUrl ?? "Available after room creation"}</strong>
                      </div>
                    </div>

                    {gamePaused ? (
                      <p className="banner banner-warning">
                        Game paused: {disconnectedPlayers.map((player) => player.displayName).join(", ")} disconnected.
                      </p>
                    ) : null}

                    <div className="split-grid">
                      <div className="card">
                        <div className="card-header">
                          <h3>Players</h3>
                          <div className="inline-actions">
                            {viewerRole === "spectator" ? (
                              <button className="ghost-button" onClick={() => joinAs("player")} type="button">
                                Become player
                              </button>
                            ) : null}
                            {viewerRole !== "spectator" && !isHost ? (
                              <button className="ghost-button" onClick={() => joinAs("spectator")} type="button">
                                Become spectator
                              </button>
                            ) : null}
                          </div>
                        </div>
                        <ul className="presence-list">
                          {snapshot.players.map((player) => (
                            <li key={player.userId}>
                              <div>
                                <strong>{player.displayName}</strong>
                                <p>
                                  {presenceRoleLabel(player.role)}
                                  {!player.connected ? " • disconnected" : ""}
                                </p>
                              </div>
                              {isHost && player.userId !== currentUserId ? (
                                <div className="inline-actions">
                                  {snapshot.lockStatus === "open" ? (
                                    <button
                                      className="ghost-button"
                                      onClick={() =>
                                        sendEvent({
                                          payload: { targetUserId: player.userId },
                                          type: "room.transfer-host"
                                        })
                                      }
                                      type="button"
                                    >
                                      Transfer host
                                    </button>
                                  ) : null}
                                  <button className="ghost-button danger" onClick={() => kickOrForceRemove(player.userId)} type="button">
                                    {snapshot.lockStatus === "open" ? "Kick" : "Force remove"}
                                  </button>
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="card">
                        <h3>Spectators</h3>
                        <ul className="presence-list">
                          {snapshot.spectators.length === 0 ? <li className="empty">No spectators.</li> : null}
                          {snapshot.spectators.map((spectator) => (
                            <li key={spectator.userId}>
                              <div>
                                <strong>{spectator.displayName}</strong>
                                <p>{spectator.connected ? "watching live" : "offline"}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>

                    <div className="split-grid">
                      <div className="card">
                        <h3>Seats</h3>
                        <ol className="seat-list">
                          {seatedPlayers.map((seat) => (
                            <li key={`${seat.seat}-${seat.userId}`}>
                              <span className="seat-number">{seat.seat + 1}</span>
                              <div>
                                <strong>{seat.displayName}</strong>
                                <p>{seat.connected ? "ready" : "offline"}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>

                      <div className="card">
                        <h3>Host controls</h3>
                        <p className="small-copy">Host-only controls for the lobby and active game.</p>
                        <div className="button-row">
                          <button disabled={!isHost || snapshot.lockStatus !== "open"} onClick={() => sendEvent({ payload: { roomId: activeRoom.id }, type: "room.randomize-seats" })} type="button">
                            Randomize seats
                          </button>
                        </div>
                        <div className="swap-grid">
                          <label>
                            <span>Left seat</span>
                            <select
                              disabled={!isHost || snapshot.lockStatus !== "open"}
                              onChange={(event) => setRoomForms((current) => ({ ...current, seatSwapLeft: event.target.value }))}
                              value={roomForms.seatSwapLeft}
                            >
                              <option value="">Select</option>
                              {seatedPlayers.map((seat) => (
                                <option key={`left-${seat.seat}`} value={String(seat.seat)}>
                                  Seat {seat.seat + 1}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>Right seat</span>
                            <select
                              disabled={!isHost || snapshot.lockStatus !== "open"}
                              onChange={(event) => setRoomForms((current) => ({ ...current, seatSwapRight: event.target.value }))}
                              value={roomForms.seatSwapRight}
                            >
                              <option value="">Select</option>
                              {seatedPlayers.map((seat) => (
                                <option key={`right-${seat.seat}`} value={String(seat.seat)}>
                                  Seat {seat.seat + 1}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <button
                          disabled={!isHost || snapshot.lockStatus !== "open"}
                          onClick={() =>
                            sendEvent({
                              payload: {
                                leftSeat: Number(roomForms.seatSwapLeft),
                                rightSeat: Number(roomForms.seatSwapRight)
                              },
                              type: "room.seat-swap"
                            })
                          }
                          type="button"
                        >
                          Swap seats
                        </button>
                        {activeGame && isHost ? (
                          <div className="button-row">
                            <button className="ghost-button danger" onClick={endGame} type="button">
                              End current game
                            </button>
                          </div>
                        ) : null}
                      </div>
                    </div>

                    <section className="card game-card">
                      <div className="card-header">
                        <div>
                          <h3>Game</h3>
                          {activeGame ? (
                            <p className="meta-line">
                              Phase {activeGame.status} • Round {activeGame.round} • Attempt {activeGame.attempt}
                            </p>
                          ) : (
                            <p className="meta-line">No active game.</p>
                          )}
                        </div>
                        {activeGame ? (
                          <div className="score-strip">
                            <span>Quests {missionTrack(activeGame.missionResults)}</span>
                            <span>Rejects {activeGame.rejectTracker}/5</span>
                          </div>
                        ) : null}
                      </div>

                      {secretState ? (
                        <div className="secret-card">
                          <div className="card-header">
                            <div>
                              <h4>Secret brief</h4>
                              <p className="small-copy">Press and hold to reveal your private information.</p>
                            </div>
                            <button
                              className={isSecretRevealActive ? "chip active" : "chip"}
                              onMouseDown={() => setIsSecretRevealActive(true)}
                              onMouseLeave={() => setIsSecretRevealActive(false)}
                              onMouseUp={() => setIsSecretRevealActive(false)}
                              onTouchEnd={() => setIsSecretRevealActive(false)}
                              onTouchStart={() => setIsSecretRevealActive(true)}
                              type="button"
                            >
                              Hold to reveal
                            </button>
                            {activeGame ? (
                              <button className="chip" onClick={refreshSecretState} type="button">
                                Refresh brief
                              </button>
                            ) : null}
                          </div>
                          <div className={isSecretRevealActive ? "secret-body revealed" : "secret-body"}>
                            {isSecretRevealActive ? (
                              <>
                                <p>
                                  <strong>{session?.user.displayName ?? "Player"}</strong>
                                </p>
                                <p>
                                  <strong>{secretState.role ? roleLabel(secretState.role) : "观战"}</strong> • {teamLabel(secretState)}
                                </p>
                                <ul className="visible-players">
                                  {secretState.visiblePlayers.length === 0 ? <li>No extra private information.</li> : null}
                                  {secretState.visiblePlayers.map((player) => (
                                    <li key={`${player.userId}-${player.reason}`}>
                                      {player.displayName}
                                      {player.role ? ` • ${roleLabel(player.role)}` : ""}
                                      {player.team ? ` • ${player.team}` : ""}
                                    </li>
                                  ))}
                                </ul>
                              </>
                            ) : (
                              <p>Private information hidden.</p>
                            )}
                          </div>
                        </div>
                      ) : null}

                      {!activeGame ? (
                        <div className="start-game-grid">
                          <div>
                            <h4>Special roles</h4>
                            <p className="small-copy">Merlin, Percival, Assassin, and Morgana are mandatory. At 7+ players, the host may also add Mordred or Oberon.</p>
                            <div className="checkbox-grid">
                              {MANDATORY_ROLES.map((role) => (
                                <label className="checkbox" key={role}>
                                  <input checked disabled type="checkbox" />
                                  <span>{roleLabel(role)}</span>
                                </label>
                              ))}
                              {ROLE_OPTIONS.map((option) => (
                                <label className="checkbox" key={option.value}>
                                  <input
                                    checked={roomForms.selectedRoles.includes(option.value)}
                                    disabled={!isHost || players.length < 7}
                                    onChange={() => toggleOptionalRole(option.value)}
                                    type="checkbox"
                                  />
                                  <span>{option.label}</span>
                                </label>
                              ))}
                            </div>
                          </div>
                          <button disabled={!isHost || players.length < 5 || players.length > 10} onClick={startGame} type="button">
                            Start game
                          </button>
                        </div>
                      ) : (
                        <div className="game-flow">
                          <div className="callout">
                            <p>
                              Leader: <strong>{proposalLeaderName}</strong>
                            </p>
                            <p>
                              Mission size: <strong>{activeGame.missionSize ?? "n/a"}</strong>
                            </p>
                            {proposedTeam.length > 0 ? (
                              <p>
                                Proposed team: <strong>{proposedTeam.map((player) => player.displayName).join(", ")}</strong>
                              </p>
                            ) : null}
                            {activeGame.status === "team-vote" && pendingTeamVoters.length > 0 ? (
                              <p>
                                Vote please: <strong>{pendingTeamVoters.join(" ")}</strong>
                              </p>
                            ) : null}
                          </div>

                          {activeGame.status === "night" ? (
                            <div className="action-block">
                              <h4>Night reveal</h4>
                              <p className="small-copy">
                                Reveal private information first. The host advances to team proposal when everyone is ready.
                              </p>
                              {canAdvanceNight ? (
                                <button onClick={advanceToProposal} type="button">
                                  Advance to proposal
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {canProposeTeam ? (
                            <div className="action-block">
                              <h4>Propose quest team</h4>
                              <p className="small-copy">Choose exactly {missionSize} players.</p>
                              <div className="checkbox-grid">
                                {players.map((player) => (
                                  <label className="checkbox" key={`team-${player.userId}`}>
                                    <input
                                      checked={roomForms.selectedTeamUserIds.includes(player.userId)}
                                      onChange={() => toggleTeamMember(player.userId)}
                                      type="checkbox"
                                    />
                                    <span>{player.displayName}</span>
                                  </label>
                                ))}
                              </div>
                              <button onClick={submitTeamProposal} type="button">
                                Submit team
                              </button>
                            </div>
                          ) : null}

                          {canSubmitTeamVote ? (
                            <div className="action-block">
                              <h4>Team vote</h4>
                              <div className="button-row">
                                <button disabled={teamVoteLocked} onClick={() => submitTeamVote("approve")} type="button">
                                  Approve
                                </button>
                                <button
                                  className="ghost-button danger"
                                  disabled={teamVoteLocked}
                                  onClick={() => submitTeamVote("reject")}
                                  type="button"
                                >
                                  Reject
                                </button>
                              </div>
                              {teamVoteLocked && submittedTeamVote ? (
                                <p className="small-copy">You {submittedTeamVote === "approve" ? "approved" : "rejected"}.</p>
                              ) : null}
                            </div>
                          ) : null}

                          {canSubmitQuestVote ? (
                            <div className="action-block">
                              <h4>Quest vote</h4>
                              <div className="button-row">
                                <button disabled={questVoteLocked} onClick={() => submitQuestVote("success")} type="button">
                                  Success
                                </button>
                                {secretState?.team === "evil" ? (
                                  <button
                                    className="ghost-button danger"
                                    disabled={questVoteLocked}
                                    onClick={() => submitQuestVote("fail")}
                                    type="button"
                                  >
                                    Fail
                                  </button>
                                ) : null}
                              </div>
                              {questVoteLocked ? <p className="small-copy">Quest done.</p> : null}
                            </div>
                          ) : null}

                          {canSubmitAssassination && activeGame.assassination ? (
                            <div className="action-block">
                              <h4>Assassination</h4>
                              <div className="radio-grid">
                                {activeGame.assassination.candidateUserIds.map((userId) => (
                                  <label className="checkbox" key={`target-${userId}`}>
                                    <input
                                      checked={roomForms.selectedAssassinationTarget === userId}
                                      name="assassination-target"
                                      onChange={() =>
                                        setRoomForms((current) => ({ ...current, selectedAssassinationTarget: userId }))
                                      }
                                      type="radio"
                                    />
                                    <span>{playerLookup.get(userId) ?? userId}</span>
                                  </label>
                                ))}
                              </div>
                              <button disabled={!roomForms.selectedAssassinationTarget} onClick={submitAssassination} type="button">
                                Confirm assassination
                              </button>
                            </div>
                          ) : null}

                          {isHost && gamePaused ? (
                            <div className="action-block">
                              <h4>Paused game controls</h4>
                              <div className="stack-list">
                                {disconnectedPlayers.map((player) => (
                                  <div className="button-row" key={`paused-controls-${player.userId}`}>
                                    <button
                                      className="ghost-button"
                                      onClick={() => revealDisconnectedPlayer(player.userId)}
                                      type="button"
                                    >
                                      Reveal {player.displayName}
                                    </button>
                                    <button
                                      className="ghost-button danger"
                                      onClick={() => kickOrForceRemove(player.userId)}
                                      type="button"
                                    >
                                      Force remove {player.displayName}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            </div>
                          ) : null}
                        </div>
                      )}
                    </section>
                  </>
                ) : (
                  <p className="empty">Connecting to room.</p>
                )}
              </section>

              <section className="panel history-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">History</p>
                    <h2>Live activity</h2>
                  </div>
                  {lastEvent ? <p className="small-copy">Latest event: {lastEvent.type}</p> : null}
                </div>

                {activeGame ? (
                  <div className="card">
                    <ul className="activity-list">
                      {liveActivity.length === 0 ? <li className="empty">Live room events will appear here.</li> : null}
                      {liveActivity.map((item) => (
                        <li key={item.id}>
                          <strong>{item.message}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="empty">Live activity appears only while a game is active.</p>
                )}
              </section>
            </section>
          ) : null}
        </>
      )}
    </main>
  );
}

function sendRoomEvent(socket: WebSocket, event: RoomClientEvent): void {
  socket.send(JSON.stringify(event));
}
