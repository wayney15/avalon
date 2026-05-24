import type { AuthUser, GameSummary, QuestVote, Role, RoomClientEvent, RoomServerEvent } from "../../../packages/shared/src";
import { assignRolesToRoster, isTwoFailMission, missionTeamSize, shuffleValues, validateRoleSelection } from "./game-rules";
import type { Env } from "./context";
import { isPredefinedChatSentence } from "./predefined-chat";
import { loadRoomPresenceState, loadRoomSnapshotPayload } from "./room-state";
import {
  appendGameEvent,
  createStartedGame,
  finalizeGame,
  loadActiveGameState,
  loadGamePlayerRoster,
  loadRoomMemberRoster,
  loadRoomRow,
  persistGameState,
  randomizeRoomSeats,
  removeRoomParticipant,
  removeRoomSpectator,
  swapRoomSeats,
  transferRoomHost,
  updateGameScore,
  updateRoomTimestamp,
  upsertRoomMember,
  upsertRoomSpectator,
  type PersistedGameState,
  type RoomRow
} from "./rooms";

interface RoomConnection {
  roomId: string;
  socket: WebSocket;
  user: AuthUser;
  userId: string;
}

interface SerializedConnection {
  connectionId: string;
  displayName: string;
  roomId: string;
  userId: string;
  username: string;
}

interface ReplaySummaryRow extends GameSummary {}

function nowIso(): string {
  return new Date().toISOString();
}

function isActiveGameplayStatus(status: string): boolean {
  return status !== "finished" && status !== "unfinished";
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function isWebSocketUpgrade(value: string | null): boolean {
  return value?.toLowerCase() === "websocket";
}

function eventEnvelope<T extends RoomServerEvent["type"]>(
  type: T,
  payload: Extract<RoomServerEvent, { type: T }>["payload"]
): Extract<RoomServerEvent, { type: T }> {
  return {
    occurredAt: nowIso(),
    payload,
    type
  } as Extract<RoomServerEvent, { type: T }>;
}

export class RoomCoordinator {
  private readonly connections = new Map<string, RoomConnection>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    for (const socket of this.state.getWebSockets()) {
      const metadata = socket.deserializeAttachment() as SerializedConnection | null;
      if (!metadata) {
        socket.close(1011, "missing_connection_metadata");
        continue;
      }

      this.connections.set(metadata.connectionId, {
        roomId: metadata.roomId,
        socket,
        user: {
          displayName: metadata.displayName,
          id: metadata.userId,
          username: metadata.username
        },
        userId: metadata.userId
      });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ ok: true });
    }

    if (request.method !== "GET" || url.pathname !== "/ws") {
      return jsonResponse({ error: "Not found" }, 404);
    }

    if (!isWebSocketUpgrade(request.headers.get("Upgrade"))) {
      return jsonResponse({ error: "Expected websocket upgrade." }, 426);
    }

    const roomId = request.headers.get("x-avalon-room-id") ?? url.searchParams.get("roomId");
    const userId = request.headers.get("x-avalon-user-id") ?? url.searchParams.get("userId");
    const username = request.headers.get("x-avalon-username") ?? url.searchParams.get("username");
    const displayName = request.headers.get("x-avalon-display-name") ?? url.searchParams.get("displayName");

    if (!roomId || !userId || !username || !displayName) {
      return jsonResponse({ error: "Missing room or user context." }, 400);
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const connectionId = crypto.randomUUID();

    this.closeDuplicateConnections(roomId, userId);

    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      connectionId,
      displayName,
      roomId,
      userId,
      username
    } satisfies SerializedConnection);
    this.connections.set(connectionId, {
      roomId,
      socket: server,
      user: {
        displayName,
        id: userId,
        username
      },
      userId
    });

    await this.handlePlayerReconnect(roomId, userId);
    await this.sendSnapshot(connectionId);
    await this.broadcastRoomState(roomId);

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connectionId = this.findConnectionId(ws);
    if (!connectionId) {
      return;
    }

    let event: RoomClientEvent | null = null;
    if (typeof message !== "string") {
      this.sendEvent(ws, eventEnvelope("error", { code: "invalid_frame", message: "Only text frames are supported." }));
      return;
    }

    try {
      event = JSON.parse(message) as RoomClientEvent;
    } catch {
      this.sendEvent(ws, eventEnvelope("error", { code: "invalid_json", message: "Message payload must be valid JSON." }));
      return;
    }

    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      this.sendError(ws, "invalid_event", "Message payload must include an event type.");
      return;
    }

    await this.handleEvent(connectionId, ws, event);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const connectionId = this.findConnectionId(ws);
    if (!connectionId) {
      return;
    }

    const connection = this.connections.get(connectionId);
    this.connections.delete(connectionId);

    if (connection) {
      await this.handlePlayerDisconnect(connection);
      await this.cleanupDisconnectedSpectator(connection);
      await this.broadcastSnapshots(connection.roomId);
      await this.broadcastRoomState(connection.roomId);
    }
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  private findConnectionId(socket: WebSocket): string | null {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.socket === socket) {
        return connectionId;
      }
    }

    return null;
  }

  private closeDuplicateConnections(roomId: string, userId: string): void {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.roomId !== roomId || connection.userId !== userId) {
        continue;
      }

      connection.socket.close(1000, "replaced_by_reconnect");
      this.connections.delete(connectionId);
    }
  }

  private connectedUserIdsForRoom(roomId: string): Set<string> {
    return new Set(
      Array.from(this.connections.values())
        .filter((connection) => connection.roomId === roomId)
        .map((connection) => connection.userId)
    );
  }

  private isUserConnected(roomId: string, userId: string): boolean {
    return Array.from(this.connections.values()).some(
      (connection) => connection.roomId === roomId && connection.userId === userId
    );
  }

  private isGamePaused(state: PersistedGameState): boolean {
    return (state.disconnectedUserIds?.length ?? 0) > 0;
  }

  private async sendSnapshot(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const payload = await loadRoomSnapshotPayload(
      this.env.DB,
      connection.roomId,
      this.connectedUserIdsForRoom(connection.roomId),
      connection.userId
    );

    if (!payload) {
      this.sendEvent(
        connection.socket,
        eventEnvelope("error", { code: "room_not_found", message: "That room does not exist." })
      );
      connection.socket.close(1008, "room_not_found");
      this.connections.delete(connectionId);
      return;
    }

    this.sendEvent(connection.socket, eventEnvelope("room.snapshot", payload));
  }

  private async broadcastRoomState(roomId: string): Promise<void> {
    const roomConnections = Array.from(this.connections.values()).filter((connection) => connection.roomId === roomId);
    if (roomConnections.length === 0) {
      return;
    }

    const state = await loadRoomPresenceState(this.env.DB, roomId, this.connectedUserIdsForRoom(roomId));
    if (!state) {
      return;
    }

    const presenceEvent = eventEnvelope("room.presence.updated", {
      players: state.players,
      roomId,
      spectators: state.spectators
    });
    const seatingEvent = eventEnvelope("room.seating.updated", {
      roomId,
      seats: state.seats
    });

    for (const connection of roomConnections) {
      this.sendEvent(connection.socket, presenceEvent);
      this.sendEvent(connection.socket, seatingEvent);
    }
  }

  private async broadcastSnapshots(roomId: string): Promise<void> {
    const roomConnections = Array.from(this.connections.entries()).filter(([, connection]) => connection.roomId === roomId);
    for (const [connectionId] of roomConnections) {
      await this.sendSnapshot(connectionId);
    }
  }

  private async handleEvent(connectionId: string, ws: WebSocket, event: RoomClientEvent): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    switch (event.type) {
      case "room.connect":
        await this.sendSnapshot(connectionId);
        return;
      case "room.leave":
        await this.handleLeave(connection, ws);
        return;
      case "room.join-player":
        await this.handleJoinPlayer(connection, ws);
        return;
      case "room.join-spectator":
        await this.handleJoinSpectator(connection, ws);
        return;
      case "room.transfer-host":
        await this.handleTransferHost(connection, ws, event.payload.targetUserId);
        return;
      case "room.seat-swap":
        await this.handleSeatSwap(connection, ws, event.payload.leftSeat, event.payload.rightSeat);
        return;
      case "room.randomize-seats":
        await this.handleRandomizeSeats(connection, ws);
        return;
      case "room.kick-player":
        await this.handleKickPlayer(connection, ws, event.payload.targetUserId);
        return;
      case "room.start-game":
        await this.handleStartGame(connection, ws, event.payload.roles);
        return;
      case "room.end-game":
        await this.handleEndGame(connection, ws);
        return;
      case "room.reveal-disconnected":
        await this.handleRevealDisconnected(connection, ws, event.payload.targetUserId);
        return;
      case "game.advance-to-proposal":
        await this.handleAdvanceToProposal(connection, ws, event.payload.gameId);
        return;
      case "game.propose-team":
        await this.handleProposeTeam(connection, ws, event.payload.gameId, event.payload.teamUserIds);
        return;
      case "game.submit-team-vote":
        await this.handleSubmitTeamVote(connection, ws, event.payload.gameId, event.payload.vote);
        return;
      case "game.submit-quest-vote":
        await this.handleSubmitQuestVote(connection, ws, event.payload.gameId, event.payload.vote);
        return;
      case "game.submit-assassination":
        await this.handleSubmitAssassination(connection, ws, event.payload.gameId, event.payload.targetUserId);
        return;
      case "game.send-predefined-chat":
        await this.handleSendPredefinedChat(connection, ws, event.payload.gameId, event.payload.sentence);
        return;
      case "game.request-role-reveal":
        await this.handleRequestRoleReveal(connectionId, connection, ws, event.payload.gameId);
        return;
      default:
        this.sendError(ws, "unsupported_event", "That event is not implemented yet.");
    }
  }

  private async handleJoinPlayer(connection: RoomConnection, ws: WebSocket): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "This room is locked while a game is in progress.");
      return;
    }

    await upsertRoomMember(this.env.DB, room, connection.user);
    await updateRoomTimestamp(this.env.DB, room.id);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleJoinSpectator(connection: RoomConnection, ws: WebSocket): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "This room is locked while a game is in progress.");
      return;
    }

    if (room.hostUserId === connection.userId) {
      this.sendError(ws, "invalid_request", "The host must remain a player in the room.");
      return;
    }

    await upsertRoomSpectator(this.env.DB, room, connection.user);
    await updateRoomTimestamp(this.env.DB, room.id);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleLeave(connection: RoomConnection, ws: WebSocket): Promise<void> {
    await this.cleanupDisconnectedSpectator(connection);
    ws.close(1000, "left_room");
  }

  private async handleTransferHost(connection: RoomConnection, ws: WebSocket, targetUserId: string): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can transfer host privileges.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "Host transfer is only available while the room is open.");
      return;
    }

    if (!(await this.isRoomMember(room.id, targetUserId))) {
      this.sendError(ws, "target_not_in_room", "The target player is not in the room.");
      return;
    }

    await transferRoomHost(this.env.DB, room.id, targetUserId);
    this.broadcastEvent(room.id, eventEnvelope("room.host.updated", { roomId: room.id, hostUserId: targetUserId }));
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleSeatSwap(
    connection: RoomConnection,
    ws: WebSocket,
    leftSeat: number,
    rightSeat: number
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can change seating.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "Seats cannot be changed while a game is in progress.");
      return;
    }

    if (!Number.isInteger(leftSeat) || !Number.isInteger(rightSeat) || leftSeat < 0 || rightSeat < 0 || leftSeat === rightSeat) {
      this.sendError(ws, "invalid_seat_swap", "Provide two different non-negative seat indexes.");
      return;
    }

    const swapped = await swapRoomSeats(this.env.DB, room.id, leftSeat, rightSeat);
    if (!swapped) {
      this.sendError(ws, "seat_not_found", "Both seats must be occupied before they can be swapped.");
      return;
    }

    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleRandomizeSeats(connection: RoomConnection, ws: WebSocket): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can randomize seats.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "Seats cannot be randomized while a game is in progress.");
      return;
    }

    await randomizeRoomSeats(this.env.DB, room.id);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleKickPlayer(connection: RoomConnection, ws: WebSocket, targetUserId: string): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can remove a player.");
      return;
    }

    if (targetUserId === connection.userId) {
      this.sendError(ws, "invalid_request", "The host cannot kick themselves.");
      return;
    }

    if (!(await this.isRoomMember(room.id, targetUserId))) {
      this.sendError(ws, "target_not_in_room", "The target player is not in the room.");
      return;
    }

    if (room.status === "open") {
      await removeRoomParticipant(this.env.DB, room.id, targetUserId);
      this.closeUserConnections(room.id, targetUserId, "removed_from_room");
      await this.broadcastSnapshots(room.id);
      await this.broadcastRoomState(room.id);
      return;
    }

    await this.handleForceRemoveDisconnectedPlayer(room, ws, targetUserId);
  }

  private async handleRevealDisconnected(connection: RoomConnection, ws: WebSocket, targetUserId: string): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || !room.activeGameId) {
      this.sendError(ws, "game_not_found", "That room does not have an active game.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can reveal a disconnected player.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, room.activeGameId),
      loadGamePlayerRoster(this.env.DB, room.activeGameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (!state.disconnectedUserIds?.includes(targetUserId)) {
      this.sendError(ws, "target_not_disconnected", "That player is not currently disconnected.");
      return;
    }

    if (!roster.some((player) => player.userId === targetUserId)) {
      this.sendError(ws, "target_not_in_game", "That player is not part of the active game.");
      return;
    }

    if (state.revealedDisconnectedUserIds?.includes(targetUserId)) {
      this.sendError(ws, "already_revealed", "That disconnected player has already been revealed.");
      return;
    }

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "player.disconnected.revealed",
      gameId: room.activeGameId,
      payload: {
        gameId: room.activeGameId,
        targetUserId
      },
      subjectUserId: targetUserId,
      visibleTo: "all"
    });
    await persistGameState(this.env.DB, room.activeGameId, connection.userId, {
      ...state,
      revealedDisconnectedUserIds: [...(state.revealedDisconnectedUserIds ?? []), targetUserId]
    });

    await this.broadcastSnapshots(room.id);
  }

  private async handleStartGame(connection: RoomConnection, ws: WebSocket, roles: Role[]): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room) {
      this.sendError(ws, "room_not_found", "That room does not exist.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can start the game.");
      return;
    }

    if (room.status !== "open") {
      this.sendError(ws, "room_locked", "This room already has an active game.");
      return;
    }

    if (!Array.isArray(roles) || roles.some((role) => typeof role !== "string")) {
      this.sendError(ws, "invalid_roles", "Roles must be provided as an array of role identifiers.");
      return;
    }

    const roster = await loadRoomMemberRoster(this.env.DB, room.id);
    const validation = validateRoleSelection(roles, roster.length);
    if (!validation.ok) {
      this.sendError(ws, "invalid_roles", validation.message);
      return;
    }

    if (roster.length < 5 || roster.length > 10) {
      this.sendError(ws, "invalid_player_count", "Games require between 5 and 10 players.");
      return;
    }

    if (roster.length === 0) {
      this.sendError(ws, "invalid_room_state", "The room has no seated players.");
      return;
    }

    const assignments = assignRolesToRoster(roster, validation.roles).map((assignment) => ({
      ...assignment,
      isHost: assignment.userId === room.hostUserId
    }));
    const leaderUserId = roster[0].userId;
    const { gameId } = await createStartedGame(this.env.DB, {
      assignments,
      hostUserId: connection.userId,
      leaderUserId,
      playerCount: roster.length,
      roomId: room.id
    });

    this.broadcastEvent(room.id, eventEnvelope("room.locked", { roomId: room.id }));
    this.broadcastEvent(
      room.id,
      eventEnvelope("game.phase.changed", {
        attempt: 1,
        gameId,
        leaderUserId,
        phase: "night",
        round: 1
      })
    );
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleEndGame(connection: RoomConnection, ws: WebSocket): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || !room.activeGameId) {
      this.sendError(ws, "game_not_found", "That room does not have an active game.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can end the current game.");
      return;
    }

    const gameId = room.activeGameId;
    const roster = await loadGamePlayerRoster(this.env.DB, gameId);
    if (roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game roster could not be loaded.");
      return;
    }

    await finalizeGame(this.env.DB, {
      endedReason: "host_ended_game",
      finalOutcome: "unfinished",
      gameId,
      roomId: room.id,
      status: "unfinished",
      winner: null
    });
    await this.appendFinalRoleReveal(gameId, roster, connection.userId);
    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "game.terminated",
      gameId,
      payload: {
        gameId,
        reason: "host_ended_game",
        status: "unfinished"
      },
      visibleTo: "all"
    });

    this.broadcastEvent(
      room.id,
      eventEnvelope("game.terminated", {
        gameId,
        reason: "host_ended_game",
        status: "unfinished"
      })
    );
    this.broadcastEvent(room.id, eventEnvelope("room.unlocked", { roomId: room.id }));
    await this.broadcastHistoryAvailability(room.id, gameId);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleAdvanceToProposal(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    if (room.hostUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the host can advance the game out of night.");
      return;
    }

    const state = await loadActiveGameState(this.env.DB, gameId);
    if (!state) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (state.status !== "night") {
      this.sendError(ws, "invalid_phase", "The game can only be advanced from the night phase.");
      return;
    }

    const phaseChange = {
      attempt: state.attempt,
      gameId,
      leaderUserId: state.leaderUserId,
      phase: "proposal" as const,
      round: state.round
    };

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "game.phase.changed",
      gameId,
      payload: phaseChange,
      visibleTo: "all"
    });
    await persistGameState(this.env.DB, gameId, connection.userId, {
      ...state,
      status: "proposal"
    });

    this.broadcastEvent(room.id, eventEnvelope("game.phase.changed", phaseChange));
    await this.broadcastSnapshots(room.id);
  }

  private async handleProposeTeam(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string,
    teamUserIds: string[]
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, gameId),
      loadGamePlayerRoster(this.env.DB, gameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (state.status !== "proposal") {
      this.sendError(ws, "invalid_phase", "The game is not accepting team proposals right now.");
      return;
    }

    if (state.leaderUserId !== connection.userId) {
      this.sendError(ws, "forbidden", "Only the current leader can propose the quest team.");
      return;
    }

    if (!Array.isArray(teamUserIds) || teamUserIds.some((userId) => typeof userId !== "string")) {
      this.sendError(ws, "invalid_team", "Team proposals must be an array of player user ids.");
      return;
    }

    const requiredTeamSize = missionTeamSize(roster.length, state.round);
    if (!requiredTeamSize) {
      this.sendError(ws, "invalid_game_state", "This round has no valid mission size.");
      return;
    }

    const activePlayerIds = new Set(roster.map((player) => player.userId));
    const uniqueTeamUserIds = [...new Set(teamUserIds)];
    if (uniqueTeamUserIds.length !== teamUserIds.length) {
      this.sendError(ws, "invalid_team", "Quest teams cannot include the same player twice.");
      return;
    }

    if (uniqueTeamUserIds.length !== requiredTeamSize) {
      this.sendError(ws, "invalid_team_size", `This mission requires exactly ${requiredTeamSize} players.`);
      return;
    }

    if (uniqueTeamUserIds.some((userId) => !activePlayerIds.has(userId))) {
      this.sendError(ws, "invalid_team", "Every proposed quest member must be an active player in this game.");
      return;
    }

    const proposal = {
      attempt: state.attempt,
      gameId,
      leaderUserId: state.leaderUserId,
      round: state.round,
      teamUserIds: uniqueTeamUserIds
    };

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "team.proposed",
      gameId,
      payload: proposal,
      visibleTo: "all"
    });
    await persistGameState(this.env.DB, gameId, connection.userId, {
      ...state,
      questVotes: {},
      status: "team-vote",
      teamUserIds: uniqueTeamUserIds,
      teamVotes: {}
    });

    this.broadcastEvent(room.id, eventEnvelope("game.team.proposed", proposal));
    this.broadcastEvent(
      room.id,
      eventEnvelope("game.phase.changed", {
        attempt: state.attempt,
        gameId,
        leaderUserId: state.leaderUserId,
        phase: "team-vote",
        round: state.round
      })
    );
    await this.broadcastSnapshots(room.id);
  }

  private async handleSubmitTeamVote(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string,
    vote: "approve" | "reject"
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    if (vote !== "approve" && vote !== "reject") {
      this.sendError(ws, "invalid_vote", "Team votes must be approve or reject.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, gameId),
      loadGamePlayerRoster(this.env.DB, gameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (state.status !== "team-vote" || !state.teamUserIds) {
      this.sendError(ws, "invalid_phase", "The game is not accepting team votes right now.");
      return;
    }

    if (!roster.some((player) => player.userId === connection.userId)) {
      this.sendError(ws, "forbidden", "Only active players may submit a team vote.");
      return;
    }

    const teamVotes = state.teamVotes ?? {};
    if (teamVotes[connection.userId]) {
      this.sendError(ws, "duplicate_vote", "That player has already submitted a team vote.");
      return;
    }

    const updatedVotes = {
      ...teamVotes,
      [connection.userId]: vote
    };

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "team.vote.submitted",
      gameId,
      payload: {
        attempt: state.attempt,
        gameId,
        round: state.round,
        vote
      },
      subjectUserId: connection.userId,
      visibleTo: "self"
    });

    if (Object.keys(updatedVotes).length < roster.length) {
      await persistGameState(this.env.DB, gameId, connection.userId, {
        ...state,
        teamVotes: updatedVotes
      });
      await this.broadcastSnapshots(room.id);
      return;
    }

    const votes = roster.map((player) => ({
      userId: player.userId,
      vote: updatedVotes[player.userId]
    }));
    const approveCount = votes.filter((entry) => entry.vote === "approve").length;
    const approved = approveCount > votes.length - approveCount;
    const rejectTracker = approved ? 0 : state.rejectTracker + 1;

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "team.vote.revealed",
      gameId,
      payload: {
        approved,
        attempt: state.attempt,
        gameId,
        rejectTracker,
        round: state.round,
        votes
      },
      visibleTo: "all"
    });

    this.broadcastEvent(
      room.id,
      eventEnvelope("game.team.vote.revealed", {
        approved,
        attempt: state.attempt,
        gameId,
        rejectTracker,
        round: state.round,
        votes
      })
    );

    if (approved) {
      await persistGameState(this.env.DB, gameId, connection.userId, {
        ...state,
        questVotes: {},
        rejectTracker: 0,
        status: "quest-vote"
      });
      this.broadcastEvent(
        room.id,
        eventEnvelope("game.phase.changed", {
          attempt: state.attempt,
          gameId,
          leaderUserId: state.leaderUserId,
          phase: "quest-vote",
          round: state.round
        })
      );
      await this.broadcastSnapshots(room.id);
      return;
    }

    if (rejectTracker >= 5) {
      await finalizeGame(this.env.DB, {
        endedReason: "five_rejections",
        finalOutcome: "evil_win",
        gameId,
        roomId: room.id,
        status: "finished",
        winner: "evil"
      });
      await this.appendFinalRoleReveal(gameId, roster, connection.userId);
      await appendGameEvent(this.env.DB, {
        actorUserId: connection.userId,
        eventType: "game.finished",
        gameId,
        payload: {
          gameId,
          winner: "evil"
        },
        visibleTo: "all"
      });
      this.broadcastEvent(room.id, eventEnvelope("game.finished", { gameId, winner: "evil" }));
      this.broadcastEvent(room.id, eventEnvelope("room.unlocked", { roomId: room.id }));
      await this.broadcastHistoryAvailability(room.id, gameId);
      await this.broadcastSnapshots(room.id);
      await this.broadcastRoomState(room.id);
      return;
    }

    const nextLeaderUserId = this.nextLeaderUserId(roster.map((player) => player.userId), state.leaderUserId);
    await persistGameState(this.env.DB, gameId, connection.userId, {
      attempt: state.attempt + 1,
      disconnectedUserIds: state.disconnectedUserIds ?? [],
      leaderUserId: nextLeaderUserId,
      questVotes: {},
      rejectTracker,
      revealedDisconnectedUserIds: state.revealedDisconnectedUserIds ?? [],
      round: state.round,
      status: "proposal",
      teamUserIds: [],
      teamVotes: {}
    });

    this.broadcastEvent(
      room.id,
      eventEnvelope("game.phase.changed", {
        attempt: state.attempt + 1,
        gameId,
        leaderUserId: nextLeaderUserId,
        phase: "proposal",
        round: state.round
      })
    );
    await this.broadcastSnapshots(room.id);
  }

  private async handleSubmitQuestVote(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string,
    vote: QuestVote
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    if (vote !== "success" && vote !== "fail") {
      this.sendError(ws, "invalid_vote", "Quest votes must be success or fail.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, gameId),
      loadGamePlayerRoster(this.env.DB, gameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (state.status !== "quest-vote" || !state.teamUserIds) {
      this.sendError(ws, "invalid_phase", "The game is not accepting quest votes right now.");
      return;
    }

    const player = roster.find((entry) => entry.userId === connection.userId);
    if (!player) {
      this.sendError(ws, "forbidden", "Only active players may submit a quest vote.");
      return;
    }

    if (!state.teamUserIds.includes(connection.userId)) {
      this.sendError(ws, "forbidden", "Only approved quest team members may submit a quest vote.");
      return;
    }

    if (player.team === "good" && vote !== "success") {
      this.sendError(ws, "invalid_vote", "Good players may only submit success on quests.");
      return;
    }

    const questVotes = state.questVotes ?? {};
    if (questVotes[connection.userId]) {
      this.sendError(ws, "duplicate_vote", "That player has already submitted a quest vote.");
      return;
    }

    const updatedVotes = {
      ...questVotes,
      [connection.userId]: vote
    };

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "quest.vote.submitted",
      gameId,
      payload: {
        gameId,
        round: state.round,
        vote
      },
      subjectUserId: connection.userId,
      visibleTo: "self"
    });

    if (Object.keys(updatedVotes).length < state.teamUserIds.length) {
      await persistGameState(this.env.DB, gameId, connection.userId, {
        ...state,
        questVotes: updatedVotes
      });
      return;
    }

    const cards = shuffleValues(state.teamUserIds.map((userId) => updatedVotes[userId]));
    const failCount = cards.filter((card) => card === "fail").length;
    const successCount = cards.length - failCount;
    const evilMissionWin = isTwoFailMission(roster.length, state.round) ? failCount >= 2 : failCount >= 1;
    const winner = evilMissionWin ? "evil" : "good";
    const currentScore = await this.currentMissionScores(gameId);
    const score = {
      evil: winner === "evil" ? currentScore.evil + 1 : currentScore.evil,
      good: winner === "good" ? currentScore.good + 1 : currentScore.good
    };

    await updateGameScore(this.env.DB, gameId, score);
    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "quest.result.revealed",
      gameId,
      payload: {
        cards,
        failCount,
        gameId,
        missionSize: cards.length,
        round: state.round,
        score,
        successCount,
        winner
      },
      visibleTo: "all"
    });
    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "score.updated",
      gameId,
      payload: {
        gameId,
        score
      },
      visibleTo: "all"
    });

    this.broadcastEvent(
      room.id,
      eventEnvelope("game.quest.result.revealed", {
        cards,
        failCount,
        gameId,
        missionSize: cards.length,
        round: state.round,
        score,
        successCount,
        winner
      })
    );

    if (score.evil >= 3) {
      await finalizeGame(this.env.DB, {
        endedReason: "evil_win",
        finalOutcome: "evil_win",
        gameId,
        roomId: room.id,
        status: "finished",
        winner: "evil"
      });
      await this.appendFinalRoleReveal(gameId, roster, connection.userId);
      await appendGameEvent(this.env.DB, {
        actorUserId: connection.userId,
        eventType: "game.finished",
        gameId,
        payload: {
          gameId,
          winner: "evil"
        },
        visibleTo: "all"
      });
      this.broadcastEvent(room.id, eventEnvelope("game.finished", { gameId, winner: "evil" }));
      this.broadcastEvent(room.id, eventEnvelope("room.unlocked", { roomId: room.id }));
      await this.broadcastHistoryAvailability(room.id, gameId);
      await this.broadcastSnapshots(room.id);
      await this.broadcastRoomState(room.id);
      return;
    }

    if (score.good >= 3) {
      const assassin = roster.find((entry) => entry.role === "assassin");
      const candidateUserIds = roster.filter((entry) => entry.team === "good").map((entry) => entry.userId);
      if (!assassin) {
        this.sendError(ws, "invalid_game_state", "The active game has no assassin.");
        return;
      }

      await appendGameEvent(this.env.DB, {
        actorUserId: connection.userId,
        eventType: "assassination.started",
        gameId,
        payload: {
          assassinUserId: assassin.userId,
          candidateUserIds,
          gameId
        },
        visibleTo: "all"
      });
      await persistGameState(this.env.DB, gameId, connection.userId, {
        assassination: {
          assassinUserId: assassin.userId,
          candidateUserIds
        },
        attempt: state.attempt,
        disconnectedUserIds: state.disconnectedUserIds ?? [],
        leaderUserId: state.leaderUserId,
        questVotes: {},
        rejectTracker: 0,
        revealedDisconnectedUserIds: state.revealedDisconnectedUserIds ?? [],
        round: state.round,
        status: "assassination",
        teamUserIds: []
      });
      this.broadcastEvent(
        room.id,
        eventEnvelope("game.assassination.started", {
          assassinUserId: assassin.userId,
          candidateUserIds,
          gameId
        })
      );
      this.broadcastEvent(
        room.id,
        eventEnvelope("game.phase.changed", {
          attempt: state.attempt,
          gameId,
          leaderUserId: state.leaderUserId,
          phase: "assassination",
          round: state.round
        })
      );
      await this.broadcastSnapshots(room.id);
      return;
    }

    const nextLeaderUserId = this.nextLeaderUserId(roster.map((entry) => entry.userId), state.leaderUserId);
    await persistGameState(this.env.DB, gameId, connection.userId, {
      attempt: 1,
      disconnectedUserIds: state.disconnectedUserIds ?? [],
      leaderUserId: nextLeaderUserId,
      questVotes: {},
      rejectTracker: 0,
      revealedDisconnectedUserIds: state.revealedDisconnectedUserIds ?? [],
      round: state.round + 1,
      status: "proposal",
      teamUserIds: [],
      teamVotes: {}
    });
    this.broadcastEvent(
      room.id,
      eventEnvelope("game.phase.changed", {
        attempt: 1,
        gameId,
        leaderUserId: nextLeaderUserId,
        phase: "proposal",
        round: state.round + 1
      })
    );
    await this.broadcastSnapshots(room.id);
  }

  private async handleSubmitAssassination(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string,
    targetUserId: string
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, gameId),
      loadGamePlayerRoster(this.env.DB, gameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (state.status !== "assassination" || !state.assassination) {
      this.sendError(ws, "invalid_phase", "The game is not accepting assassination input right now.");
      return;
    }

    if (connection.userId !== state.assassination.assassinUserId) {
      this.sendError(ws, "forbidden", "Only the assassin may choose a target.");
      return;
    }

    if (!state.assassination.candidateUserIds.includes(targetUserId)) {
      this.sendError(ws, "invalid_target", "The assassination target must be a valid good-side candidate.");
      return;
    }

    const target = roster.find((entry) => entry.userId === targetUserId);
    if (!target) {
      this.sendError(ws, "invalid_target", "That assassination target is not part of the active roster.");
      return;
    }

    const hitMerlin = target.role === "merlin";
    const winner = hitMerlin ? "evil" : "good";

    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "assassination.resolved",
      gameId,
      payload: {
        assassinUserId: state.assassination.assassinUserId,
        hitMerlin,
        targetUserId
      },
      visibleTo: "all"
    });
    await finalizeGame(this.env.DB, {
      endedReason: hitMerlin ? "assassination" : "good_win",
      finalOutcome: hitMerlin ? "evil_win" : "good_win",
      gameId,
      roomId: room.id,
      status: "finished",
      winner
    });
    await this.appendFinalRoleReveal(gameId, roster, connection.userId);
    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "game.finished",
      gameId,
      payload: {
        gameId,
        winner
      },
      visibleTo: "all"
    });

    this.broadcastEvent(room.id, eventEnvelope("game.finished", { gameId, winner }));
    this.broadcastEvent(room.id, eventEnvelope("room.unlocked", { roomId: room.id }));
    await this.broadcastHistoryAvailability(room.id, gameId);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async handleRequestRoleReveal(
    connectionId: string,
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    await this.sendSnapshot(connectionId);
  }

  private async handleSendPredefinedChat(
    connection: RoomConnection,
    ws: WebSocket,
    gameId: string,
    sentence: string
  ): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room || room.activeGameId !== gameId) {
      this.sendError(ws, "game_not_found", "That game is not active in this room.");
      return;
    }

    if (typeof sentence !== "string") {
      this.sendError(ws, "invalid_sentence", "That sentence is not in the predefined chat list.");
      return;
    }

    const normalizedSentence = sentence.trim();
    if (!normalizedSentence || !isPredefinedChatSentence(normalizedSentence)) {
      this.sendError(ws, "invalid_sentence", "That sentence is not in the predefined chat list.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, gameId),
      loadGamePlayerRoster(this.env.DB, gameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (this.isGamePaused(state)) {
      this.sendError(ws, "game_paused", "The game is paused until all disconnected players return.");
      return;
    }

    if (!isActiveGameplayStatus(state.status)) {
      this.sendError(ws, "invalid_phase", "The game is not accepting chat messages right now.");
      return;
    }

    if (!roster.some((player) => player.userId === connection.userId)) {
      this.sendError(ws, "forbidden", "Only current game players may use predefined chat.");
      return;
    }

    const chatEvent = eventEnvelope("game.predefined-chat.sent", {
      gameId,
      senderDisplayName: connection.user.displayName,
      senderUserId: connection.userId,
      sentence: normalizedSentence
    });

    this.broadcastEventToUsers(
      room.id,
      new Set(roster.map((player) => player.userId).filter((userId) => userId !== connection.userId)),
      chatEvent
    );
  }

  private async isRoomMember(roomId: string, userId: string): Promise<boolean> {
    return (
      (await this.env.DB
        .prepare("SELECT 1 AS present FROM room_members WHERE room_id = ? AND user_id = ?")
        .bind(roomId, userId)
        .first<{ present: number }>()) !== null
    );
  }

  private async handlePlayerDisconnect(connection: RoomConnection): Promise<void> {
    const room = await loadRoomRow(this.env.DB, connection.roomId);
    if (!room?.activeGameId) {
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, room.activeGameId),
      loadGamePlayerRoster(this.env.DB, room.activeGameId)
    ]);

    if (!state || !roster.some((player) => player.userId === connection.userId)) {
      return;
    }

    const disconnectedUserIds = new Set(state.disconnectedUserIds ?? []);
    if (disconnectedUserIds.has(connection.userId)) {
      return;
    }

    disconnectedUserIds.add(connection.userId);
    await appendGameEvent(this.env.DB, {
      actorUserId: connection.userId,
      eventType: "player.disconnected",
      gameId: room.activeGameId,
      payload: {
        disconnectedUserId: connection.userId,
        gameId: room.activeGameId
      },
      subjectUserId: connection.userId,
      visibleTo: "all"
    });
    await persistGameState(this.env.DB, room.activeGameId, connection.userId, {
      ...state,
      disconnectedUserIds: [...disconnectedUserIds]
    });
    this.broadcastEvent(
      room.id,
      eventEnvelope("game.paused", {
        disconnectedUserId: connection.userId,
        gameId: room.activeGameId,
        reason: "player_disconnected"
      })
    );
  }

  private async handlePlayerReconnect(roomId: string, userId: string): Promise<void> {
    const room = await loadRoomRow(this.env.DB, roomId);
    if (!room?.activeGameId) {
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, room.activeGameId),
      loadGamePlayerRoster(this.env.DB, room.activeGameId)
    ]);

    if (!state || !roster.some((player) => player.userId === userId) || !state.disconnectedUserIds?.includes(userId)) {
      return;
    }

    const remainingDisconnectedUserIds = state.disconnectedUserIds.filter((candidateUserId) => candidateUserId !== userId);
    await appendGameEvent(this.env.DB, {
      actorUserId: userId,
      eventType: "player.reconnected",
      gameId: room.activeGameId,
      payload: {
        gameId: room.activeGameId,
        reconnectedUserId: userId
      },
      subjectUserId: userId,
      visibleTo: "all"
    });
    await persistGameState(this.env.DB, room.activeGameId, userId, {
      ...state,
      disconnectedUserIds: remainingDisconnectedUserIds,
      revealedDisconnectedUserIds: (state.revealedDisconnectedUserIds ?? []).filter(
        (candidateUserId) => candidateUserId !== userId
      )
    });

    if (remainingDisconnectedUserIds.length === 0) {
      this.broadcastEvent(room.id, eventEnvelope("game.resumed", { gameId: room.activeGameId }));
    }
  }

  private async handleForceRemoveDisconnectedPlayer(room: RoomRow, ws: WebSocket, targetUserId: string): Promise<void> {
    if (!room.activeGameId) {
      this.sendError(ws, "invalid_room_state", "The room is locked but has no active game.");
      return;
    }

    const activeGameId = room.activeGameId;

    if (this.isUserConnected(room.id, targetUserId)) {
      this.sendError(ws, "invalid_request", "Only disconnected players may be force-removed during a game.");
      return;
    }

    const [state, roster] = await Promise.all([
      loadActiveGameState(this.env.DB, activeGameId),
      loadGamePlayerRoster(this.env.DB, activeGameId)
    ]);

    if (!state || roster.length === 0) {
      this.sendError(ws, "invalid_game_state", "The active game state could not be loaded.");
      return;
    }

    if (!roster.some((player) => player.userId === targetUserId)) {
      this.sendError(ws, "target_not_in_game", "The target player is not in the active game.");
      return;
    }

    if (!state.disconnectedUserIds?.includes(targetUserId)) {
      this.sendError(ws, "invalid_request", "Only disconnected active players may be force-removed.");
      return;
    }

    await appendGameEvent(this.env.DB, {
      actorUserId: room.hostUserId,
      eventType: "host.force_removed_disconnected_player",
      gameId: activeGameId,
      payload: {
        gameId: activeGameId,
        targetUserId
      },
      subjectUserId: targetUserId,
      visibleTo: "all"
    });

    let nextHostUserId: string | null = null;
    if (targetUserId === room.hostUserId) {
      const replacementCandidates = roster.map((player) => player.userId).filter((userId) => userId !== targetUserId);
      nextHostUserId = replacementCandidates[0] ?? null;
      if (nextHostUserId) {
        await transferRoomHost(this.env.DB, room.id, nextHostUserId);
        this.broadcastEvent(room.id, eventEnvelope("room.host.updated", { roomId: room.id, hostUserId: nextHostUserId }));
      }
    }

    await removeRoomParticipant(this.env.DB, room.id, targetUserId);
    await finalizeGame(this.env.DB, {
      endedReason: "forced_termination",
      finalOutcome: "unfinished",
      gameId: activeGameId,
      roomId: room.id,
      status: "unfinished",
      winner: null
    });
    await this.appendFinalRoleReveal(activeGameId, roster, room.hostUserId);
    await appendGameEvent(this.env.DB, {
      actorUserId: room.hostUserId,
      eventType: "game.terminated",
      gameId: activeGameId,
      payload: {
        gameId: activeGameId,
        reason: "host_force_removed_disconnected_player",
        status: "unfinished"
      },
      visibleTo: "all"
    });

    this.closeUserConnections(room.id, targetUserId, "removed_from_room");
    this.broadcastEvent(
      room.id,
      eventEnvelope("game.terminated", {
        gameId: activeGameId,
        reason: "host_force_removed_disconnected_player",
        status: "unfinished"
      })
    );
    this.broadcastEvent(room.id, eventEnvelope("room.unlocked", { roomId: room.id }));
    await this.broadcastHistoryAvailability(room.id, activeGameId);
    await this.broadcastSnapshots(room.id);
    await this.broadcastRoomState(room.id);
  }

  private async appendFinalRoleReveal(
    gameId: string,
    roster: Array<{ displayName: string; role: Role; team: "good" | "evil"; userId: string }>,
    actorUserId: string
  ): Promise<void> {
    await appendGameEvent(this.env.DB, {
      actorUserId,
      eventType: "roles.revealed",
      gameId,
      payload: {
        assignments: roster.map((player) => ({
          displayName: player.displayName,
          role: player.role,
          team: player.team,
          userId: player.userId
        })),
        gameId
      },
      visibleTo: "all"
    });
  }

  private async broadcastHistoryAvailability(roomId: string, gameId: string): Promise<void> {
    const game = await this.env.DB
      .prepare(
        `SELECT
          id,
          room_id AS roomId,
          status,
          started_at AS startedAt,
          ended_at AS endedAt,
          winner
        FROM games
        WHERE id = ?`
      )
      .bind(gameId)
      .first<ReplaySummaryRow>();

    if (!game) {
      return;
    }

    this.broadcastEvent(roomId, eventEnvelope("history.game.available", { game, roomId }));
  }

  private closeUserConnections(roomId: string, userId: string, reason: string): void {
    for (const [connectionId, connection] of this.connections.entries()) {
      if (connection.roomId !== roomId || connection.userId !== userId) {
        continue;
      }

      connection.socket.close(1000, reason);
      this.connections.delete(connectionId);
    }
  }

  private broadcastEvent(roomId: string, event: RoomServerEvent): void {
    for (const connection of this.connections.values()) {
      if (connection.roomId === roomId) {
        this.sendEvent(connection.socket, event);
      }
    }
  }

  private broadcastEventToUsers(roomId: string, userIds: Set<string>, event: RoomServerEvent): void {
    for (const connection of this.connections.values()) {
      if (connection.roomId === roomId && userIds.has(connection.userId)) {
        this.sendEvent(connection.socket, event);
      }
    }
  }

  private sendError(socket: WebSocket, code: string, message: string): void {
    this.sendEvent(socket, eventEnvelope("error", { code, message }));
  }

  private async cleanupDisconnectedSpectator(connection: RoomConnection): Promise<void> {
    const spectator = await this.env.DB
      .prepare("SELECT 1 AS present FROM room_spectators WHERE room_id = ? AND user_id = ?")
      .bind(connection.roomId, connection.userId)
      .first<{ present: number }>();

    if (spectator) {
      await removeRoomSpectator(this.env.DB, connection.roomId, connection.userId);
    }
  }

  private nextLeaderUserId(seatOrderedUserIds: string[], currentLeaderUserId: string): string {
    const currentIndex = seatOrderedUserIds.indexOf(currentLeaderUserId);
    if (currentIndex === -1 || seatOrderedUserIds.length === 0) {
      return currentLeaderUserId;
    }

    return seatOrderedUserIds[(currentIndex + 1) % seatOrderedUserIds.length];
  }

  private async currentMissionScores(gameId: string): Promise<{ good: number; evil: number }> {
    const row = await this.env.DB
      .prepare(
        `SELECT
          mission_wins_good AS good,
          mission_wins_evil AS evil
        FROM games
        WHERE id = ?`
      )
      .bind(gameId)
      .first<{ good: number; evil: number }>();

    return {
      evil: Number(row?.evil ?? 0),
      good: Number(row?.good ?? 0)
    };
  }

  private sendEvent(socket: WebSocket, event: RoomServerEvent): void {
    socket.send(JSON.stringify(event));
  }
}
