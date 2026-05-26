import { useEffect, useMemo, useRef, useState } from "react";
import assassinImage from "../asset/Assasin.png";
import loyalServantImage from "../asset/LoyalServant.png";
import merlinImage from "../asset/Merlin.png";
import minionOfMordredImage from "../asset/MinionOfMordred.png";
import morganaImage from "../asset/Morgana.png";
import mordredImage from "../asset/Mordred.png";
import oberonImage from "../asset/Oberon.png";
import percivalImage from "../asset/Percival.png";
import predefinedSentencesText from "../asset/sentence.txt?raw";
import { reconcileLiveActivityFromSnapshot } from "./live-activity";
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
  RoomActivityItem,
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
import { normalizePredefinedSentences } from "../../../packages/shared/src";

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

interface ReplayEntry {
  id: string;
  message: string;
}

interface ChatPopupItem {
  id: string;
  message: string;
}

interface WinnerPopupState {
  message: string;
  winner: "good" | "evil" | null;
}

const API_BASE = resolveApiBase();
const SESSION_STORAGE_KEY = "avalon.session";
const LAST_ROOM_STORAGE_KEY = "avalon.last-room-id";
const ROLE_OPTIONS: Array<{ label: string; value: RoleChoice }> = [
  { label: "莫德雷德", value: "mordred" },
  { label: "奥伯伦", value: "oberon" }
];
const MANDATORY_ROLES: RoleChoice[] = ["merlin", "percival", "assassin", "morgana"];
const PREDEFINED_CHAT_SENTENCES = normalizePredefinedSentences(predefinedSentencesText);

function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE_URL?.trim();
  if (fromEnv) {
    return fromEnv.replace(/\/$/, "");
  }

  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  if (!isLocalHost) {
    throw new Error("VITE_API_BASE_URL is required for non-local frontend builds.");
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
      return `${resolveName(event.payload.hostUserId)} 现在是房主。`;
    case "room.locked":
      return "房间已锁定，游戏进行中。";
    case "room.unlocked":
      return "房间已回到大厅状态。";
    case "game.team.proposed":
      return `${resolveName(event.payload.leaderUserId)} 提议队伍：${event.payload.teamUserIds.map(resolveName).join("、")}。`;
    case "game.team.vote.revealed": {
      const approvedBy = event.payload.votes
        .filter((entry) => entry.vote === "approve")
        .map((entry) => resolveName(entry.userId))
        .join(" ");
      const rejectedBy = event.payload.votes
        .filter((entry) => entry.vote === "reject")
        .map((entry) => resolveName(entry.userId))
        .join(" ");
      return event.payload.approved
        ? `队伍表决通过。\n赞成 ✓：${approvedBy || "无人"}\n反对 ✗：${rejectedBy || "无人"}`
        : `队伍表决未通过。\n赞成 ✓：${approvedBy || "无人"}\n反对 ✗：${rejectedBy || "无人"}`;
    }
    case "game.quest.result.revealed":
      return `第 ${event.payload.round} 次任务${event.payload.winner === "good" ? "成功" : "失败"}，出现 ${event.payload.failCount} 张失败票。`;
    case "game.paused":
      return `${resolveName(event.payload.disconnectedUserId)} 已断线，游戏暂停。`;
    case "game.resumed":
      return "所有必要玩家已返回，游戏继续。";
    case "game.assassination.started":
      return `${resolveName(event.payload.assassinUserId)} 正在选择刺杀目标。`;
    case "game.finished":
      return gameResultNotice(event.payload.winner);
    case "game.terminated":
      return event.payload.reason === "host_ended_game"
        ? "房主结束了当前游戏。"
        : "房主强制移除掉线玩家后，游戏已终止。";
    case "history.game.available":
      return "一局已完成的游戏已加入历史记录。";
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

function roleImageSrc(role: Role | null | undefined): string | null {
  switch (role) {
    case "merlin":
      return merlinImage;
    case "percival":
      return percivalImage;
    case "loyal-servant":
      return loyalServantImage;
    case "assassin":
      return assassinImage;
    case "morgana":
      return morganaImage;
    case "mordred":
      return mordredImage;
    case "oberon":
      return oberonImage;
    case "minion":
      return minionOfMordredImage;
    default:
      return null;
  }
}

function teamLabel(secretState: ViewerSecretState | null): string {
  if (!secretState || !secretState.team) {
    return "观战";
  }

  return secretState.team === "good" ? "好人" : "坏人";
}

function teamName(team: "good" | "evil" | null | undefined): string {
  if (team === "good") {
    return "好人";
  }

  if (team === "evil") {
    return "坏人";
  }

  return "未知";
}

function visibilityLabel(visibility: "open" | "locked"): string {
  return visibility === "open" ? "开放" : "锁定";
}

function socketStatusLabel(status: SocketStatus): string {
  switch (status) {
    case "connected":
      return "已连接";
    case "connecting":
      return "连接中";
    case "offline":
      return "离线";
    default:
      return status;
  }
}

function gameStatusLabel(status: ActiveGameView["status"]): string {
  switch (status) {
    case "night":
      return "夜晚";
    case "proposal":
      return "提名";
    case "team-vote":
      return "队伍表决";
    case "quest-vote":
      return "任务投票";
    case "assassination":
      return "刺杀";
    case "finished":
      return "已结束";
    case "unfinished":
      return "未完成";
    case "lobby":
      return "大厅";
    default:
      return status;
  }
}

function roomEventTypeLabel(type: RoomServerEvent["type"]): string {
  switch (type) {
    case "room.snapshot":
      return "房间快照";
    case "room.presence.updated":
      return "在线状态更新";
    case "room.host.updated":
      return "房主变更";
    case "room.seating.updated":
      return "座位更新";
    case "room.locked":
      return "房间锁定";
    case "room.unlocked":
      return "房间解锁";
    case "game.phase.changed":
      return "阶段变更";
    case "game.team.proposed":
      return "队伍提议";
    case "game.team.vote.revealed":
      return "队伍表决结果";
    case "game.quest.result.revealed":
      return "任务结果";
    case "game.paused":
      return "游戏暂停";
    case "game.resumed":
      return "游戏继续";
    case "game.assassination.started":
      return "刺杀开始";
    case "game.predefined-chat.sent":
      return "快捷发言";
    case "game.finished":
      return "游戏结束";
    case "game.terminated":
      return "游戏终止";
    case "history.game.available":
      return "历史记录更新";
    case "error":
      return "错误";
    default:
      return type;
  }
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

function isActiveGameplayStatus(status: ActiveGameView["status"]): boolean {
  return status !== "finished" && status !== "unfinished";
}

function formatTeamVoteBreakdown(
  votes: Array<{ userId: string; vote: TeamVote }>,
  resolveName: (userId: string) => string
): string {
  const approvedBy = votes.filter((entry) => entry.vote === "approve").map((entry) => resolveName(entry.userId));
  const rejectedBy = votes.filter((entry) => entry.vote === "reject").map((entry) => resolveName(entry.userId));
  return `赞成：${approvedBy.join("、") || "无人"}。反对：${rejectedBy.join("、") || "无人"}。`;
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
        message: `队长 ${resolveName(payload.leaderUserId)} 提议队伍：${payload.teamUserIds.map(resolveName).join("、")}。`
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
          message: `队长 ${resolveName(lastProposal.leaderUserId)} 的队伍未通过。${formatTeamVoteBreakdown(payload.votes, resolveName)}`
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
        message: `队长 ${leaderUserId ? resolveName(leaderUserId) : "未知"} 派出 ${teamUserIds.map(resolveName).join("、")}。第 ${payload.round} 次任务${payload.winner === "good" ? "成功" : "失败"}，出现 ${payload.failCount} 张失败票。${voteBreakdown}`
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
    return "游戏结束，好人胜利。";
  }

  if (winner === "evil") {
    return "游戏结束，坏人胜利。";
  }

  return "游戏结束。";
}

export function App() {
  const inviteTokenFromPath = useMemo(() => parseInviteTokenFromPath(window.location.pathname), []);
  const socketRef = useRef<WebSocket | null>(null);
  const playerLookupRef = useRef<Map<string, string>>(new Map());
  const reconnectTimerRef = useRef<number | null>(null);
  const suppressAutoRestoreRef = useRef(false);
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
  const [liveActivity, setLiveActivity] = useState<RoomActivityItem[]>([]);
  const [isSecretRevealActive, setIsSecretRevealActive] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [lastInviteUrl, setLastInviteUrl] = useState<string | null>(null);
  const [submittedTeamVote, setSubmittedTeamVote] = useState<TeamVote | null>(null);
  const [submittedQuestVote, setSubmittedQuestVote] = useState(false);
  const [socketReconnectNonce, setSocketReconnectNonce] = useState(0);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [chatPopups, setChatPopups] = useState<ChatPopupItem[]>([]);
  const [winnerPopup, setWinnerPopup] = useState<WinnerPopupState | null>(null);
  const [roomDetailsOpen, setRoomDetailsOpen] = useState(false);

  const viewerRole = inferViewerPresenceRole(snapshot, session?.user.id ?? "");
  const isHost = viewerRole === "host";
  const isPlayer = viewerRole === "host" || viewerRole === "player";
  const activeGame = snapshot?.activeGame ?? null;
  const isGameInProgress = activeGame ? isActiveGameplayStatus(activeGame.status) : false;
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
  const canUsePredefinedChat = isPlayer && isGameInProgress && !gamePaused;
  const canToggleRoomDetails = isGameInProgress && Boolean(activeRoom);
  const roomDetailsVisible = !isGameInProgress || roomDetailsOpen;
  const activeChatPopup = chatPopups[0] ?? null;
  const showLiveActivity = Boolean(activeGame) || liveActivity.length > 0;

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
      setChatMenuOpen(false);
      setChatPopups([]);
      setWinnerPopup(null);
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
        setScreenError("当前登录状态已失效，请重新登录。");
      });

    return () => {
      cancelled = true;
    };
  }, [session?.token]);

  useEffect(() => {
    if (!session || activeRoom) {
      return;
    }

    if (suppressAutoRestoreRef.current) {
      suppressAutoRestoreRef.current = false;
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
      setChatMenuOpen(false);
      setChatPopups([]);
      setWinnerPopup(null);
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
        setLiveActivity((current) => reconcileLiveActivityFromSnapshot(current, parsed.payload));
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
            ? "队伍表决通过，进入任务投票。"
            : `队伍表决未通过，当前连续否决次数为 ${parsed.payload.rejectTracker}。`
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
          `第 ${parsed.payload.round} 次任务${parsed.payload.winner === "good" ? "成功" : "失败"}（成功票 ${parsed.payload.successCount}，失败票 ${parsed.payload.failCount}）。`
        );
        return;
      }

      if (parsed.type === "game.paused") {
        setScreenNotice(`${playerLookup.get(parsed.payload.disconnectedUserId) ?? "有玩家"} 已断线，游戏暂停。`);
        return;
      }

      if (parsed.type === "game.resumed") {
        setScreenNotice("所有必要玩家都已返回，游戏继续。");
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
        setScreenNotice("刺杀阶段开始。");
        return;
      }

      if (parsed.type === "game.predefined-chat.sent") {
        setChatPopups((current) => [
          ...current,
          {
            id: `${parsed.payload.senderUserId}-${parsed.occurredAt}-${current.length}`,
            message: `${parsed.payload.senderDisplayName}: ${parsed.payload.sentence}`
          }
        ]);
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
        setWinnerPopup({
          message: gameResultNotice(parsed.payload.winner),
          winner: parsed.payload.winner
        });
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
            ? "房主结束了当前游戏。"
            : "房主强制移除掉线玩家后，游戏已终止。"
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
      setScreenError("房间连接失败。");
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

  useEffect(() => {
    if (!canUsePredefinedChat) {
      setChatMenuOpen(false);
    }
  }, [canUsePredefinedChat]);

  useEffect(() => {
    setRoomDetailsOpen(false);
  }, [activeGame?.id, isGameInProgress]);

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
      setScreenError(error instanceof Error ? error.message : "无法加载你的对局历史。");
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
        error: error instanceof Error ? error.message : "无法加载回放。",
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
      setScreenError("没有找到可重新加入的房间。");
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
      setScreenNotice(authMode === "signup" ? "账号已创建。" : "登录成功。");
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "认证失败。");
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
      setScreenNotice(`房间已创建。邀请链接：${response.inviteUrl}`);
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "无法创建房间。");
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
      setScreenNotice(joinForm.asSpectator ? "已作为观战者加入。" : "已加入房间。");
    } catch (error) {
      setScreenError(error instanceof Error ? error.message : "无法加入房间。");
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
        setScreenNotice("已重新加入房间。");
      }
    } finally {
      setIsBusy(false);
    }
  }

  function sendEvent(event: RoomClientEvent): boolean {
    clearFeedback();
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setScreenError("房间实时连接尚未打开。");
      return false;
    }

    sendRoomEvent(socket, event);
    return true;
  }

  async function handleLeaveRoom(): Promise<void> {
    suppressAutoRestoreRef.current = true;
    sendEvent({ payload: { roomId: activeRoom?.id ?? "" }, type: "room.leave" });
    socketRef.current?.close();
    socketRef.current = null;
    if (window.location.pathname.startsWith("/rooms/invite/")) {
      window.history.replaceState({}, "", "/");
    }
    setActiveRoom(null);
    setSnapshot(null);
    setHistorySelectionOpen(false);
    setReplay({ data: null, error: null, gameId: null, loading: false });
    setLiveActivity([]);
    setChatMenuOpen(false);
    setChatPopups([]);
    setWinnerPopup(null);
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

    if (!window.confirm("确认结束当前游戏并返回大厅吗？")) {
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

    const targetName = playerLookup.get(roomForms.selectedAssassinationTarget) ?? "该玩家";
    if (!window.confirm(`确认将刺杀目标设为：${targetName}？`)) {
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

  function sendPredefinedChat(sentence: string): void {
    if (!activeGame) {
      return;
    }

    if (sendEvent({
      payload: {
        gameId: activeGame.id,
        sentence
      },
      type: "game.send-predefined-chat"
    })) {
      setChatMenuOpen(false);
    }
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
            <strong>{session ? session.user.displayName : "未登录"}</strong>
            <span className="top-bar-room">{activeRoom ? activeRoom.code : "无房间"}</span>
          </div>
          {canUsePredefinedChat || canToggleRoomDetails ? (
            <div className="top-bar-actions">
              {canToggleRoomDetails ? (
                <button
                  className={roomDetailsOpen ? "ghost-button active-top-bar-button" : "ghost-button"}
                  onClick={() => setRoomDetailsOpen((current) => !current)}
                  type="button"
                >
                  房间详情
                </button>
              ) : null}
              {canUsePredefinedChat ? (
                <button
                  className={chatMenuOpen ? "ghost-button active-top-bar-button" : "ghost-button"}
                  onClick={() => setChatMenuOpen((current) => !current)}
                  type="button"
                >
                  快捷发言
                </button>
              ) : null}
              {canUsePredefinedChat && chatMenuOpen ? (
                <div className="chat-menu" role="menu">
                  <ul className="chat-menu-list">
                    {PREDEFINED_CHAT_SENTENCES.map((sentence) => (
                      <li key={sentence}>
                        <button
                          className="chat-menu-item"
                          onClick={() => sendPredefinedChat(sentence)}
                          type="button"
                        >
                          {sentence}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {screenError ? <p className="banner banner-error">{screenError}</p> : null}
      {screenNotice ? <p className="banner banner-notice">{screenNotice}</p> : null}

      {!session ? (
        <section className="panel auth-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">账号</p>
              <h2>{authMode === "signup" ? "创建账号" : "登录"}</h2>
            </div>
            <div className="segmented">
              <button
                className={authMode === "login" ? "chip active" : "chip"}
                onClick={() => setAuthMode("login")}
                type="button"
              >
                登录
              </button>
              <button
                className={authMode === "signup" ? "chip active" : "chip"}
                onClick={() => setAuthMode("signup")}
                type="button"
              >
                注册
              </button>
            </div>
          </div>

          <div className="form-grid">
            <label>
              <span>用户名</span>
              <input
                autoComplete="username"
                onChange={(event) => setAuthForm((current) => ({ ...current, username: event.target.value }))}
                placeholder="arthur_host"
                value={authForm.username}
              />
            </label>
            {authMode === "signup" ? (
              <label>
                <span>显示名称</span>
                <input
                  autoComplete="nickname"
                  onChange={(event) => setAuthForm((current) => ({ ...current, displayName: event.target.value }))}
                placeholder="亚瑟"
                  value={authForm.displayName}
                />
              </label>
            ) : null}
            <label>
                <span>密码</span>
              <input
                autoComplete={authMode === "signup" ? "new-password" : "current-password"}
                onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
                placeholder="至少 8 个字符"
                type="password"
                value={authForm.password}
              />
            </label>
          </div>

          <button disabled={isBusy} onClick={() => void handleAuthSubmit()} type="button">
            {authMode === "signup" ? "创建账号" : "登录"}
          </button>
        </section>
      ) : (
        <>
          {!activeRoom ? (
            <section className="panel setup-panel">
              <div className="panel-header">
                <div>
                  <p className="eyebrow">房间</p>
                  <h2>创建或加入</h2>
                </div>
                <button
                  className="ghost-button"
                  onClick={() => {
                    setSession(null);
                    clearFeedback();
                  }}
                  type="button"
                >
                  退出登录
                </button>
              </div>

              <div className="split-grid">
                <div className="card">
                  <h3>创建房间</h3>
                  <label>
                    <span>房间名称</span>
                    <input
                      onChange={(event) => setRoomForms((current) => ({ ...current, roomName: event.target.value }))}
                      placeholder="周五阿瓦隆"
                      value={roomForms.roomName}
                    />
                  </label>
                  <button disabled={isBusy} onClick={() => void handleCreateRoom()} type="button">
                    创建房间
                  </button>
                </div>

                <div className="card">
                  <h3>加入房间</h3>
                  <label>
                    <span>房间代码</span>
                    <input
                      onChange={(event) => setJoinForm((current) => ({ ...current, roomCode: event.target.value.toUpperCase() }))}
                      placeholder="K7M4Q"
                      value={joinForm.roomCode}
                    />
                  </label>
                  <label>
                    <span>邀请令牌</span>
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
                    <span>以观战者身份加入</span>
                  </label>
                  <button disabled={isBusy} onClick={() => void handleJoinRoom()} type="button">
                    加入房间
                  </button>
                  <button className="ghost-button" disabled={isBusy} onClick={() => void handleRejoinRoom()} type="button">
                    重新加入
                  </button>
                </div>

                <div className="card">
                  <h3>历史记录</h3>
                  {!replay.loading && !replay.error && !replay.data && !historySelectionOpen ? (
                    <>
                      <p className="small-copy">查看你账号下已结束的任意对局。</p>
                      <button onClick={() => void openHistorySelection()} type="button">
                        选择对局
                      </button>
                    </>
                  ) : null}
                  {historySelectionOpen ? (
                    <>
                      <p className="small-copy">从已结束的对局中选择一局。</p>
                      <ul className="history-list">
                        {historySelectionLoading ? <li className="empty">正在加载已结束对局。</li> : null}
                        {!historySelectionLoading && historyGames.length === 0 ? (
                          <li className="empty">你的账号下暂无已结束对局。</li>
                        ) : null}
                        {historyGames.map((game) => (
                          <li key={game.id}>
                            <button
                              className={replay.gameId === game.id ? "history-button active" : "history-button"}
                              onClick={() => void fetchReplay(game.id)}
                              type="button"
                            >
                              <strong>{game.roomName}</strong>
                              <span>{game.roomCode} • {game.winner ? `${teamName(game.winner)}胜利` : "已结束"}</span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {replay.loading ? <p className="empty">正在加载回放。</p> : null}
                  {replay.error ? <p className="banner banner-error">{replay.error}</p> : null}
                  {replay.data ? (
                    <>
                      <div className="replay-head">
                        <button onClick={() => void openHistorySelection()} type="button">
                          选择另一局
                        </button>
                        <p className="meta-line">
                          胜方：{replay.data.game.winner ? teamName(replay.data.game.winner) : "无"} • {replayEntries.length} 条回放记录
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
                    <p className="eyebrow">实时房间</p>
                    <h2>{activeRoom.name}</h2>
                    <p className="meta-line">
                      房间代码 {activeRoom.code} • {visibilityLabel(snapshot?.room.visibility ?? activeRoom.visibility)} • {socketStatusLabel(socketStatus)}
                    </p>
                  </div>
                  <div className="panel-actions">
                    <button className="ghost-button" onClick={() => void handleLeaveRoom()} type="button">
                      离开房间视图
                    </button>
                  </div>
                </div>

                {snapshot ? (
                  <>
                    {roomDetailsVisible ? (
                      <div className="summary-strip">
                        <div className="summary-item">
                          <span>玩家</span>
                          <strong>{snapshot.players.length}</strong>
                        </div>
                        <div className="summary-item">
                          <span>观战者</span>
                          <strong>{snapshot.spectators.length}</strong>
                        </div>
                        <div className="summary-item">
                          <span>身份</span>
                          <strong>{viewerRole ? presenceRoleLabel(viewerRole) : "旁观者"}</strong>
                        </div>
                        <div className="summary-item">
                          <span>邀请链接</span>
                          <strong className="invite-line">{lastInviteUrl ?? "创建房间后可用"}</strong>
                        </div>
                      </div>
                    ) : null}

                    {gamePaused ? (
                      <p className="banner banner-warning">
                        游戏暂停：{disconnectedPlayers.map((player) => player.displayName).join("、")} 已断线。
                      </p>
                    ) : null}

                    {roomDetailsVisible ? (
                      <div className="split-grid">
                      <div className="card">
                        <div className="card-header">
                          <h3>玩家</h3>
                          <div className="inline-actions">
                            {viewerRole === "spectator" ? (
                              <button className="ghost-button" onClick={() => joinAs("player")} type="button">
                                加入玩家席
                              </button>
                            ) : null}
                            {viewerRole !== "spectator" && !isHost ? (
                              <button className="ghost-button" onClick={() => joinAs("spectator")} type="button">
                                切换为观战
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
                                  {!player.connected ? " • 已断线" : ""}
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
                                      转移房主
                                    </button>
                                  ) : null}
                                  <button className="ghost-button danger" onClick={() => kickOrForceRemove(player.userId)} type="button">
                                    {snapshot.lockStatus === "open" ? "移出房间" : "强制移除"}
                                  </button>
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </div>

                      <div className="card">
                        <h3>观战者</h3>
                        <ul className="presence-list">
                          {snapshot.spectators.length === 0 ? <li className="empty">暂无观战者。</li> : null}
                          {snapshot.spectators.map((spectator) => (
                            <li key={spectator.userId}>
                              <div>
                                <strong>{spectator.displayName}</strong>
                                <p>{spectator.connected ? "正在观战" : "离线"}</p>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                      </div>
                    ) : null}

                    <div className="split-grid">
                      <div className="card">
                        <h3>座位</h3>
                        <ol className="seat-list">
                          {seatedPlayers.map((seat) => (
                            <li key={`${seat.seat}-${seat.userId}`}>
                              <span className="seat-number">{seat.seat + 1}</span>
                              <div>
                                <strong>{seat.displayName}</strong>
                                <p>{seat.connected ? "已就绪" : "离线"}</p>
                              </div>
                            </li>
                          ))}
                        </ol>
                      </div>

                      {roomDetailsVisible ? (
                        <div className="card">
                          <h3>房主管理</h3>
                          <p className="small-copy">仅房主可用，用于大厅和进行中的游戏。</p>
                          <div className="button-row">
                            <button disabled={!isHost || snapshot.lockStatus !== "open"} onClick={() => sendEvent({ payload: { roomId: activeRoom.id }, type: "room.randomize-seats" })} type="button">
                              随机座位
                            </button>
                          </div>
                          <div className="swap-grid">
                            <label>
                              <span>左侧座位</span>
                              <select
                                disabled={!isHost || snapshot.lockStatus !== "open"}
                                onChange={(event) => setRoomForms((current) => ({ ...current, seatSwapLeft: event.target.value }))}
                                value={roomForms.seatSwapLeft}
                              >
                                <option value="">请选择</option>
                                {seatedPlayers.map((seat) => (
                                  <option key={`left-${seat.seat}`} value={String(seat.seat)}>
                                    座位 {seat.seat + 1}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>右侧座位</span>
                              <select
                                disabled={!isHost || snapshot.lockStatus !== "open"}
                                onChange={(event) => setRoomForms((current) => ({ ...current, seatSwapRight: event.target.value }))}
                                value={roomForms.seatSwapRight}
                              >
                                <option value="">请选择</option>
                                {seatedPlayers.map((seat) => (
                                  <option key={`right-${seat.seat}`} value={String(seat.seat)}>
                                    座位 {seat.seat + 1}
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
                            交换座位
                          </button>
                          {activeGame && isHost ? (
                            <div className="button-row">
                              <button className="ghost-button danger" onClick={endGame} type="button">
                                结束当前游戏
                              </button>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>

                    <section className="card game-card">
                      <div className="card-header">
                        <div>
                          <h3>游戏</h3>
                          {activeGame ? (
                            <p className="meta-line">
                              阶段：{gameStatusLabel(activeGame.status)} • 轮次：{activeGame.round} • 尝试：{activeGame.attempt}
                            </p>
                          ) : (
                            <p className="meta-line">当前没有进行中的游戏。</p>
                          )}
                        </div>
                        {activeGame ? (
                          <div className="score-strip">
                            <span>任务进度 {missionTrack(activeGame.missionResults)}</span>
                            <span>否决 {activeGame.rejectTracker}/5</span>
                          </div>
                        ) : null}
                      </div>

                      {secretState ? (
                        <div className="secret-card">
                          <div className="card-header">
                            <div>
                              <h4>身份简报</h4>
                              <p className="small-copy">点击查看你的私密信息，再次点击可隐藏。</p>
                            </div>
                            <button
                              className={isSecretRevealActive ? "chip active" : "chip"}
                              onClick={() => setIsSecretRevealActive((current) => !current)}
                              type="button"
                            >
                              {isSecretRevealActive ? "隐藏信息" : "点击查看"}
                            </button>
                            {activeGame ? (
                              <button className="chip" onClick={refreshSecretState} type="button">
                                刷新简报
                              </button>
                            ) : null}
                          </div>
                          <div
                            className={isSecretRevealActive ? "secret-body revealed" : "secret-body"}
                            onClick={isSecretRevealActive ? () => setIsSecretRevealActive(false) : undefined}
                          >
                            {isSecretRevealActive ? (
                              <>
                                <div className="secret-layout">
                                  <div className="secret-details">
                                    <p>
                                      <span className="secret-label">用户</span>
                                      <strong>{session?.user.displayName ?? "玩家"}</strong>
                                    </p>
                                    <p>
                                      <span className="secret-label">角色</span>
                                      <strong>{secretState.role ? roleLabel(secretState.role) : "观战"}</strong>
                                    </p>
                                    <p>
                                      <span className="secret-label">阵营</span>
                                      <strong>{teamLabel(secretState)}</strong>
                                    </p>
                                    <div className="secret-visible-block">
                                      <p>
                                        <span className="secret-label">可见玩家</span>
                                      </p>
                                      <ul className="visible-players">
                                        {secretState.visiblePlayers.length === 0 ? <li>没有额外可见的私密信息。</li> : null}
                                        {secretState.visiblePlayers.map((player) => (
                                          <li key={`${player.userId}-${player.reason}`}>
                                            {player.displayName}
                                            {player.role ? ` • ${roleLabel(player.role)}` : ""}
                                            {player.team ? ` • ${teamName(player.team)}` : ""}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  </div>
                                  <div className="secret-art">
                                    {secretState.role ? (
                                      <img
                                        alt={roleLabel(secretState.role)}
                                        className="secret-role-image"
                                        src={roleImageSrc(secretState.role) ?? undefined}
                                      />
                                    ) : null}
                                  </div>
                                </div>
                              </>
                            ) : (
                              <p>私密信息已隐藏。</p>
                            )}
                          </div>
                        </div>
                      ) : null}

                      {!activeGame ? (
                        <div className="start-game-grid">
                          <div>
                            <h4>特殊角色</h4>
                            <p className="small-copy">梅林、派西维尔、刺客、莫甘娜为必选。7 人及以上时，房主可额外加入莫德雷德或奥伯伦。</p>
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
                            开始游戏
                          </button>
                        </div>
                      ) : (
                        <div className="game-flow">
                          <div className="callout">
                            <p>
                              队长：<strong>{proposalLeaderName}</strong>
                            </p>
                            <p>
                              任务人数：<strong>{activeGame.missionSize ?? "无"}</strong>
                            </p>
                            {proposedTeam.length > 0 ? (
                              <p>
                                提议队伍：<strong>{proposedTeam.map((player) => player.displayName).join("、")}</strong>
                              </p>
                            ) : null}
                            {activeGame.status === "team-vote" && pendingTeamVoters.length > 0 ? (
                              <p>
                                等待投票：<strong>{pendingTeamVoters.join("、")}</strong>
                              </p>
                            ) : null}
                          </div>

                          {activeGame.status === "night" ? (
                            <div className="action-block">
                              <h4>夜晚查看</h4>
                              <p className="small-copy">
                                请先查看私密信息。所有人准备好后，由房主推进到提名阶段。
                              </p>
                              {canAdvanceNight ? (
                                <button onClick={advanceToProposal} type="button">
                                  进入提名阶段
                                </button>
                              ) : null}
                            </div>
                          ) : null}

                          {canProposeTeam ? (
                            <div className="action-block">
                              <h4>提议任务队伍</h4>
                              <p className="small-copy">请准确选择 {missionSize} 名玩家。</p>
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
                                提交队伍
                              </button>
                            </div>
                          ) : null}

                          {canSubmitTeamVote ? (
                            <div className="action-block">
                              <h4>队伍表决</h4>
                              <div className="button-row">
                                <button disabled={teamVoteLocked} onClick={() => submitTeamVote("approve")} type="button">
                                  赞成
                                </button>
                                <button
                                  className="ghost-button danger"
                                  disabled={teamVoteLocked}
                                  onClick={() => submitTeamVote("reject")}
                                  type="button"
                                >
                                  反对
                                </button>
                              </div>
                              {teamVoteLocked && submittedTeamVote ? (
                                <p className="small-copy">你已选择：{submittedTeamVote === "approve" ? "赞成" : "反对"}。</p>
                              ) : null}
                            </div>
                          ) : null}

                          {canSubmitQuestVote ? (
                            <div className="action-block">
                              <h4>任务投票</h4>
                              <div className="button-row">
                                <button disabled={questVoteLocked} onClick={() => submitQuestVote("success")} type="button">
                                  成功
                                </button>
                                {secretState?.team === "evil" ? (
                                  <button
                                    className="ghost-button danger"
                                    disabled={questVoteLocked}
                                    onClick={() => submitQuestVote("fail")}
                                    type="button"
                                  >
                                    失败
                                  </button>
                                ) : null}
                              </div>
                              {questVoteLocked ? <p className="small-copy">任务票已提交。</p> : null}
                            </div>
                          ) : null}

                          {canSubmitAssassination && activeGame.assassination ? (
                            <div className="action-block">
                              <h4>刺杀</h4>
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
                                确认刺杀
                              </button>
                            </div>
                          ) : null}

                          {isHost && gamePaused ? (
                            <div className="action-block">
                              <h4>暂停期管理</h4>
                              <div className="stack-list">
                                {disconnectedPlayers.map((player) => (
                                  <div className="button-row" key={`paused-controls-${player.userId}`}>
                                    <button
                                      className="ghost-button"
                                      onClick={() => revealDisconnectedPlayer(player.userId)}
                                      type="button"
                                    >
                                      公开 {player.displayName}
                                    </button>
                                    <button
                                      className="ghost-button danger"
                                      onClick={() => kickOrForceRemove(player.userId)}
                                      type="button"
                                    >
                                      强制移除 {player.displayName}
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
                  <p className="empty">正在连接房间。</p>
                )}
              </section>

              <section className="panel history-panel">
                <div className="panel-header">
                  <div>
                    <p className="eyebrow">动态</p>
                    <h2>实时活动</h2>
                  </div>
                  {lastEvent ? <p className="small-copy">最新事件：{roomEventTypeLabel(lastEvent.type)}</p> : null}
                </div>

                {showLiveActivity ? (
                  <div className="card">
                    <ul className="activity-list">
                      {liveActivity.length === 0 ? <li className="empty">房间实时活动会显示在这里。</li> : null}
                      {liveActivity.map((item) => (
                        <li key={item.id}>
                          <strong>{item.message}</strong>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="empty">只有在游戏进行中才会显示实时活动。</p>
                )}
              </section>
            </section>
          ) : null}
        </>
      )}

      {activeChatPopup ? (
        <button
          aria-label="关闭聊天消息"
          className="chat-popup-overlay"
          onClick={() => setChatPopups((current) => current.slice(1))}
          type="button"
        >
          <span className="chat-popup-card">{activeChatPopup.message}</span>
        </button>
      ) : null}

      {winnerPopup ? (
        <div
          aria-modal="true"
          className="chat-popup-overlay"
          role="dialog"
        >
          <div className="chat-popup-card">
            <strong>{winnerPopup.winner === "good" ? "好人胜利" : winnerPopup.winner === "evil" ? "坏人胜利" : "游戏结束"}</strong>
            <p>{winnerPopup.message}</p>
            <button className="ghost-button" onClick={() => setWinnerPopup(null)} type="button">
              关闭
            </button>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function sendRoomEvent(socket: WebSocket, event: RoomClientEvent): void {
  socket.send(JSON.stringify(event));
}
