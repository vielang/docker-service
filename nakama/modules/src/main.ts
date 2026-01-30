// Nakama Server Module - Main Entry Point
// This module handles multiplayer match creation and management for Mall App
//
// Optimized for 50+ players with:
// - AOI (Area of Interest) based broadcasting
// - Map-based filtering
// - State batching (aggregated updates per tick)

// ============================================================================
// Constants
// ============================================================================

const AOI_CELL_SIZE = 200; // Pixels per grid cell
const AOI_RADIUS = 600; // Only broadcast to players within this radius

// OpCodes (must match Flutter's OpCode class)
const OP_PLAYER_MOVE = 1; // Legacy: client sends position
const OP_PLAYER_STATE = 2; // Server broadcasts state
const OP_MAP_CHANGE = 3; // Client changed map
const OP_PLAYER_INPUT = 4; // Server-authoritative: client sends input only
const OP_SERVER_POSITION = 5; // Server sends authoritative position

// Movement constants (must match Flutter's Player component)
const WALK_SPEED = 80; // pixels per second
const RUN_SPEED = 160; // pixels per second
const MAX_SPEED_TOLERANCE = 1.2; // Allow 20% tolerance for lag

// Direction constants (0=left, 1=right, 2=up, 3=down, 4=none)
const DIR_LEFT = 0;
const DIR_RIGHT = 1;
const DIR_UP = 2;
const DIR_DOWN = 3;
const DIR_NONE = 4;

// ============================================================================
// Movement Calculation Helpers
// ============================================================================

/**
 * Calculate velocity from direction and running state
 */
function calculateVelocity(
  direction: number,
  isRunning: boolean
): { vx: number; vy: number } {
  const speed = isRunning ? RUN_SPEED : WALK_SPEED;

  switch (direction) {
    case DIR_LEFT:
      return { vx: -speed, vy: 0 };
    case DIR_RIGHT:
      return { vx: speed, vy: 0 };
    case DIR_UP:
      return { vx: 0, vy: -speed };
    case DIR_DOWN:
      return { vx: 0, vy: speed };
    default:
      return { vx: 0, vy: 0 };
  }
}

/**
 * Update player position based on velocity and delta time
 * Returns new position (no collision checking yet)
 */
function updatePosition(
  currentX: number,
  currentY: number,
  vx: number,
  vy: number,
  dt: number
): { x: number; y: number } {
  return {
    x: currentX + vx * dt,
    y: currentY + vy * dt,
  };
}

/**
 * Encode server position to binary format (version 4)
 * Format: [version(1), x(2), y(2), direction(1), flags(1), sequence(1), reserved(1)]
 */
function encodeServerPosition(
  x: number,
  y: number,
  direction: number,
  isRunning: boolean,
  sequence: number
): ArrayBuffer {
  const buffer = new ArrayBuffer(9);
  const view = new DataView(buffer);

  view.setUint8(0, 4); // version
  view.setInt16(1, Math.round(x), true); // little endian
  view.setInt16(3, Math.round(y), true);
  view.setUint8(5, direction & 0x07);
  view.setUint8(6, isRunning ? 1 : 0);
  view.setUint8(7, sequence & 0xff);
  view.setUint8(8, 0); // reserved

  return buffer;
}

/**
 * Decode player input from binary format (version 3)
 * Format: [version(1), direction(1), flags(1), sequence(1)]
 */
function decodePlayerInput(
  data: ArrayBuffer
): { direction: number; isRunning: boolean; sequence: number } | null {
  if (data.byteLength < 4) return null;

  const view = new DataView(data);
  const version = view.getUint8(0);

  if (version !== 3) return null;

  return {
    direction: view.getUint8(1),
    isRunning: view.getUint8(2) === 1,
    sequence: view.getUint8(3),
  };
}

// ============================================================================
// AOI Grid - Spatial Partitioning for O(1) Player Queries
// Using plain objects for Nakama's goja runtime compatibility
// ============================================================================

interface AOIGridType {
  cells: { [key: string]: { [playerId: string]: boolean } };
  playerCells: { [userId: string]: string };
  cellSize: number;
}

function createAOIGrid(cellSize: number = AOI_CELL_SIZE): AOIGridType {
  return {
    cells: {},
    playerCells: {},
    cellSize: cellSize,
  };
}

function aoiGetCellKey(grid: AOIGridType, x: number, y: number): string {
  const cellX = Math.floor(x / grid.cellSize);
  const cellY = Math.floor(y / grid.cellSize);
  return cellX + ',' + cellY;
}

function aoiUpdatePlayer(grid: AOIGridType, userId: string, x: number, y: number): void {
  const newCell = aoiGetCellKey(grid, x, y);
  const oldCell = grid.playerCells[userId];

  // Skip if player hasn't changed cells
  if (oldCell === newCell) return;

  // Remove from old cell
  if (oldCell && grid.cells[oldCell]) {
    delete grid.cells[oldCell][userId];
    // Clean up empty cell
    if (Object.keys(grid.cells[oldCell]).length === 0) {
      delete grid.cells[oldCell];
    }
  }

  // Add to new cell
  if (!grid.cells[newCell]) {
    grid.cells[newCell] = {};
  }
  grid.cells[newCell][userId] = true;
  grid.playerCells[userId] = newCell;
}

function aoiRemovePlayer(grid: AOIGridType, userId: string): void {
  const cell = grid.playerCells[userId];
  if (cell && grid.cells[cell]) {
    delete grid.cells[cell][userId];
    if (Object.keys(grid.cells[cell]).length === 0) {
      delete grid.cells[cell];
    }
  }
  delete grid.playerCells[userId];
}

function aoiGetPlayersInRadius(
  grid: AOIGridType,
  centerX: number,
  centerY: number,
  radius: number
): string[] {
  const result: string[] = [];
  const seen: { [id: string]: boolean } = {};
  const cellRadius = Math.ceil(radius / grid.cellSize);
  const centerCellX = Math.floor(centerX / grid.cellSize);
  const centerCellY = Math.floor(centerY / grid.cellSize);

  // Check all cells within radius
  for (let dx = -cellRadius; dx <= cellRadius; dx++) {
    for (let dy = -cellRadius; dy <= cellRadius; dy++) {
      const cellKey = (centerCellX + dx) + ',' + (centerCellY + dy);
      const cellPlayers = grid.cells[cellKey];
      if (cellPlayers) {
        for (const playerId in cellPlayers) {
          if (!seen[playerId]) {
            seen[playerId] = true;
            result.push(playerId);
          }
        }
      }
    }
  }

  return result;
}

function aoiClear(grid: AOIGridType): void {
  grid.cells = {};
  grid.playerCells = {};
}

// ============================================================================
// Type Definitions
// ============================================================================

interface GetWaitingMatchResponse {
  matchId: string;
  playerCount: number;
  isNew: boolean;
}

interface MatchState {
  label: string;
  maxPlayers: number;
  players: { [userId: string]: MatchPlayer };
  createdAt: number;
  // AOI optimization
  aoiGrid: AOIGridType;
  // Batching: pending updates to send this tick (using object for goja compatibility)
  pendingUpdates: { [userId: string]: PendingUpdate };
}

interface PendingUpdate {
  userId: string;
  opCode: number;
  data: ArrayBuffer;
  reliable: boolean;
}

interface MatchPlayer {
  userId: string;
  sessionId: string; // Required for targeted broadcasts
  username: string;
  node: string;
  joinedAt: number;
  currentMap: string;
  lastPosition: { x: number; y: number };
  // Server-authoritative movement state
  direction: number; // Current movement direction
  isRunning: boolean;
  lastInputTime: number; // Timestamp of last input (ms)
  lastInputSequence: number; // For client reconciliation
  // Flag to skip validation on first position update
  hasReceivedFirstPosition: boolean;
}

// ============================================================================
// RPC: Get or Create Waiting Match
// ============================================================================

function rpcGetWaitingMatch(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logger.info('📞 RPC called: get_waiting_match');

  const MAX_PLAYERS = 50; // Increased for 50+ players (AOI optimized)
  const MATCH_LABEL = 'eco_conscience_global';

  try {
    // 1. List all active matches
    const matches = nk.matchList(10, true, MATCH_LABEL);
    logger.info(`Found ${matches.length} active matches`);

    // 2. Find a match that's not full
    for (const match of matches) {
      if (match.size < MAX_PLAYERS) {
        logger.info(
          `✅ Found available match: ${match.matchId} (${match.size}/${MAX_PLAYERS} players)`
        );

        const response: GetWaitingMatchResponse = {
          matchId: match.matchId,
          playerCount: match.size,
          isNew: false,
        };

        return JSON.stringify(response);
      }
    }

    // 3. No available match found, create a new one
    logger.info('🆕 Creating new match...');

    const matchId = nk.matchCreate('eco_conscience_match', {
      label: MATCH_LABEL,
      maxPlayers: MAX_PLAYERS,
    });

    logger.info(`✅ Created new match: ${matchId}`);

    const response: GetWaitingMatchResponse = {
      matchId: matchId,
      playerCount: 0,
      isNew: true,
    };

    return JSON.stringify(response);
  } catch (error) {
    logger.error(`❌ Error in get_waiting_match: ${error}`);
    throw error;
  }
}

// ============================================================================
// RPC: Create or Get Support Conversation
// ============================================================================

interface CreateSupportConversationRequest {
  userId: string;
  userName: string;
  userEmail?: string;
}

interface CreateSupportConversationResponse {
  channelId: string;
  exists: boolean;
}

interface Conversation {
  conversationId: string;
  userId: string;
  userName: string;
  userEmail?: string;
  status: 'active' | 'resolved' | 'pending';
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
  unreadCount: {
    user: number;
    admin: number;
  };
  metadata?: { [key: string]: any };
}

function rpcCreateSupportConversation(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logger.info('📞 RPC called: create_support_conversation');
  logger.info(`Raw payload: ${payload}`);

  try {
    const request: CreateSupportConversationRequest = JSON.parse(payload);
    logger.info(`Parsed request: ${JSON.stringify(request)}`);
    const { userId, userName, userEmail } = request;
    logger.info(`userId: ${userId}, userName: ${userName}, userEmail: ${userEmail}`);

    // Validate required fields
    if (!userId || userId === 'undefined' || userId === 'null') {
      logger.error(`❌ Invalid userId: ${userId}`);
      throw new Error('userId is required and must be a valid value');
    }

    if (!userName || userName.trim() === '') {
      logger.error(`❌ Invalid userName: ${userName}`);
      throw new Error('userName is required and must not be empty');
    }

    const channelId = `support_chat_${userId}`;
    logger.info(`Creating/getting support channel: ${channelId}`);

    // Check if conversation already exists
    // @ts-expect-error - storageRead exists in Nakama runtime but not in type definitions
    const objects = nk.storageRead([
      {
        collection: 'conversations',
        key: channelId,
        userId: ctx.userId, // Use current Nakama user ID
      },
    ]);

    if (objects.length > 0) {
      logger.info(`✅ Conversation exists: ${channelId}`);
      const response: CreateSupportConversationResponse = {
        channelId: channelId,
        exists: true,
      };
      return JSON.stringify(response);
    }

    // Create new conversation
    const conversation: Conversation = {
      conversationId: channelId,
      userId: userId,
      userName: userName,
      userEmail: userEmail,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastMessageAt: Date.now(),
      unreadCount: {
        user: 0,
        admin: 0,
      },
      metadata: {},
    };

    // @ts-expect-error - storageWrite exists in Nakama runtime but not in type definitions
    nk.storageWrite([
      {
        collection: 'conversations',
        key: channelId,
        userId: ctx.userId, // Use current Nakama user ID
        value: conversation,
        permissionRead: 2, // Public read
        permissionWrite: 0, // No client writes
      },
    ]);

    logger.info(`✅ Created new conversation: ${channelId}`);

    const response: CreateSupportConversationResponse = {
      channelId: channelId,
      exists: false,
    };

    return JSON.stringify(response);
  } catch (error) {
    logger.error(`❌ Error in create_support_conversation: ${error}`);
    throw error;
  }
}

// ============================================================================
// RPC: List All Conversations (Admin Only)
// ============================================================================

interface ListConversationsResponse {
  conversations: Conversation[];
  cursor?: string;
}

function rpcListConversations(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logger.info('📞 RPC called: list_conversations');

  try {
    // TODO: Add admin permission check when auth is integrated
    // For now, allow any authenticated user to list conversations

    // List all conversations from storage
    // @ts-expect-error - storageList exists in Nakama runtime but not in type definitions
    const result = nk.storageList(
      null, // userId (null for server to see all)
      'conversations',
      100, // limit
      '' // cursor (pagination)
    );

    // Filter out conversations with invalid userId
    const conversations: Conversation[] = result.objects
      .map((obj) => obj.value as Conversation)
      .filter((conv) => {
        const isValid = conv.userId && conv.userId !== 'undefined' && conv.userId !== 'null';
        if (!isValid) {
          logger.warn(`⚠️ Skipping conversation with invalid userId: ${conv.conversationId}`);
        }
        return isValid;
      });

    logger.info(`✅ Found ${conversations.length} valid conversations`);

    const response: ListConversationsResponse = {
      conversations: conversations,
      cursor: result.cursor,
    };

    return JSON.stringify(response);
  } catch (error) {
    logger.error(`❌ Error in list_conversations: ${error}`);
    throw error;
  }
}

// ============================================================================
// RPC: Mark Messages as Read
// ============================================================================

interface MarkMessagesReadRequest {
  channelId: string;
  role: 'user' | 'admin';
}

interface MarkMessagesReadResponse {
  success: boolean;
}

function rpcMarkMessagesRead(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  payload: string
): string {
  logger.info('📞 RPC called: mark_messages_read');

  try {
    const request: MarkMessagesReadRequest = JSON.parse(payload);
    const { channelId, role } = request;

    // Extract room name from channel ID
    // Channel ID format: "2...support_chat_1" -> room name: "support_chat_1"
    const roomName = channelId.includes('...')
      ? channelId.split('...')[1]
      : channelId;

    logger.info(`Extracting room name from channelId: ${channelId} -> ${roomName}`);

    // Read current conversation using room name as key
    // @ts-expect-error - storageRead exists in Nakama runtime but not in type definitions
    const objects = nk.storageRead([
      {
        collection: 'conversations',
        key: roomName,
        userId: ctx.userId, // Use current Nakama user ID
      },
    ]);

    if (objects.length === 0) {
      throw new Error(`Conversation not found: ${channelId}`);
    }

    const conversation = objects[0].value as Conversation;

    // Update unread count based on role
    if (role === 'admin') {
      conversation.unreadCount.admin = 0;
    } else {
      conversation.unreadCount.user = 0;
    }

    conversation.updatedAt = Date.now();

    // Write updated conversation back to storage
    // @ts-expect-error - storageWrite exists in Nakama runtime but not in type definitions
    nk.storageWrite([
      {
        collection: 'conversations',
        key: roomName,
        userId: ctx.userId, // Use current Nakama user ID
        value: conversation,
        permissionRead: 2,
        permissionWrite: 0,
      },
    ]);

    logger.info(`✅ Marked messages as read for ${role} in ${roomName}`);

    const response: MarkMessagesReadResponse = {
      success: true,
    };

    return JSON.stringify(response);
  } catch (error) {
    logger.error(`❌ Error in mark_messages_read: ${error}`);
    throw error;
  }
}

// ============================================================================
// Match Handler Functions
// ============================================================================

function matchInit(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  params: { [key: string]: string }
): { state: MatchState; tickRate: number; label: string } {
  logger.info('🎮 Match initializing with AOI optimization...');

  const label = params.label || 'eco_conscience_global';
  const maxPlayers = parseInt(params.maxPlayers || '50'); // Increased for 50+ players

  const state: MatchState = {
    label: label,
    maxPlayers: maxPlayers,
    players: {},
    createdAt: Date.now(),
    // Initialize AOI grid for spatial queries
    aoiGrid: createAOIGrid(AOI_CELL_SIZE),
    // Initialize pending updates object for batching (goja compatible)
    pendingUpdates: {},
  };

  logger.info(`✅ Match initialized: ${label} (max ${maxPlayers} players, AOI enabled)`);

  return {
    state: state,
    tickRate: 20, // 20 ticks per second (50ms) for smoother updates
    label: label,
  };
}

function matchJoinAttempt(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presence: nkruntime.Presence,
  metadata: { [key: string]: any }
): { state: MatchState; accept: boolean; rejectMessage?: string } | null {
  logger.info(`👤 Join attempt: ${presence.username} (${presence.userId})`);

  // Check if match is full
  const playerCount = Object.keys(state.players).length;
  if (playerCount >= state.maxPlayers) {
    logger.warn(`❌ Match full (${playerCount}/${state.maxPlayers})`);
    return {
      state: state,
      accept: false,
      rejectMessage: 'Match is full',
    };
  }

  // Accept player
  logger.info(`✅ Accepting player: ${presence.username}`);
  return {
    state: state,
    accept: true,
  };
}

function matchJoin(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
): { state: MatchState } | null {
  for (const presence of presences) {
    logger.info(`✅ Player joined: ${presence.username} (${presence.userId})`);

    const defaultX = 96;
    const defaultY = 384;

    // Add player to state (including sessionId for targeted broadcasts)
    state.players[presence.userId] = {
      userId: presence.userId,
      sessionId: presence.sessionId,
      username: presence.username,
      node: presence.node,
      joinedAt: Date.now(),
      currentMap: 'outdoors',
      lastPosition: { x: defaultX, y: defaultY }, // Default spawn position
      // Server-authoritative movement state
      direction: DIR_NONE,
      isRunning: false,
      lastInputTime: Date.now(),
      lastInputSequence: 0,
      // First position flag - allow first update without distance validation
      hasReceivedFirstPosition: false,
    };

    // Add player to AOI grid at spawn position
    aoiUpdatePlayer(state.aoiGrid, presence.userId, defaultX, defaultY);

    // Broadcast welcome message to the new player
    const welcomeData = {
      type: 'welcome',
      players: state.players,
      matchInfo: {
        label: state.label,
        playerCount: Object.keys(state.players).length,
        maxPlayers: state.maxPlayers,
      },
    };

    dispatcher.broadcastMessage(
      1, // OpCode for welcome
      JSON.stringify(welcomeData),
      [presence], // Send only to new player
      null,
      true
    );

    // Broadcast to all other players that someone joined
    // Use OpCode 20 (OP_PLAYER_JOINED) instead of 2 (OP_PLAYER_STATE)
    // This prevents Flutter from trying to parse it as movement data
    const joinNotification = {
      type: 'player_joined',
      player: state.players[presence.userId],
    };

    dispatcher.broadcastMessage(
      20, // OpCode 20 = playerJoined (not 2 = playerState)
      JSON.stringify(joinNotification),
      null, // Send to all
      presence, // Sender (exclude from broadcast)
      true
    );

    logger.info(
      `📊 Match status: ${Object.keys(state.players).length}/${state.maxPlayers} players`
    );
  }

  return { state };
}

function matchLeave(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  presences: nkruntime.Presence[]
): { state: MatchState } | null {
  for (const presence of presences) {
    logger.info(`👋 Player left: ${presence.username} (${presence.userId})`);

    // Remove player from AOI grid
    aoiRemovePlayer(state.aoiGrid, presence.userId);

    // Remove pending updates for this player
    delete state.pendingUpdates[presence.userId];

    // Remove player from state
    delete state.players[presence.userId];

    // Broadcast to remaining players
    const leaveNotification = {
      type: 'player_left',
      userId: presence.userId,
    };

    dispatcher.broadcastMessage(
      3, // OpCode for player left
      JSON.stringify(leaveNotification),
      null,
      null,
      true
    );

    logger.info(
      `📊 Match status: ${Object.keys(state.players).length}/${state.maxPlayers} players`
    );
  }

  return { state };
}

function matchLoop(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  messages: nkruntime.MatchMessage[]
): { state: MatchState } | null {
  const now = Date.now();
  const tickDt = 1.0 / 20; // 20 ticks per second = 50ms per tick

  // ============================================================================
  // PHASE 1: Process incoming messages
  // ============================================================================

  for (const message of messages) {
    const sender = message.sender;
    const senderPlayer = state.players[sender.userId];

    if (!senderPlayer) continue;

    // Handle based on OpCode
    if (message.opCode === OP_PLAYER_INPUT) {
      // ========================================
      // SERVER-AUTHORITATIVE MODE: Process input
      // ========================================
      const input = decodePlayerInput(message.data as ArrayBuffer);
      if (input) {
        // Update player's input state
        senderPlayer.direction = input.direction;
        senderPlayer.isRunning = input.isRunning;
        senderPlayer.lastInputSequence = input.sequence;
        senderPlayer.lastInputTime = now;

        // Mark player as needing position broadcast
        state.pendingUpdates[sender.userId] = {
          userId: sender.userId,
          opCode: OP_SERVER_POSITION, // Will broadcast authoritative position
          data: new ArrayBuffer(0), // Will be calculated later
          reliable: true,
        };
      }
    } else if (message.opCode === OP_PLAYER_MOVE || message.opCode === OP_PLAYER_STATE) {
      // ========================================
      // LEGACY MODE: Client sends position directly
      // (Still supported for backward compatibility)
      // ========================================
      let parsedData: { x?: number; y?: number; d?: number; r?: boolean } | null = null;

      try {
        const jsonStr = nk.binaryToString(message.data as ArrayBuffer);
        if (jsonStr.startsWith('{')) {
          parsedData = JSON.parse(jsonStr);
        }
      } catch {
        // Binary format
        try {
          const data = message.data as ArrayBuffer;
          const view = new DataView(data);

          if (data.byteLength >= 7 && view.getUint8(0) === 2) {
            // V2 binary format (7 bytes)
            parsedData = {
              x: view.getInt16(1, true),
              y: view.getInt16(3, true),
              d: view.getUint8(5),
              r: view.getUint8(6) === 1,
            };
          } else if (data.byteLength >= 10) {
            // V1 binary format (13 bytes, float32)
            parsedData = {
              x: view.getFloat32(0, true),
              y: view.getFloat32(4, true),
              d: view.getUint8(8),
              r: view.getUint8(9) === 1,
            };
          }
        } catch {
          // Ignore
        }
      }

      if (parsedData && parsedData.x !== undefined && parsedData.y !== undefined) {
        // VALIDATION: Check if movement speed is reasonable (anti-cheat)
        const lastPos = senderPlayer.lastPosition;
        const dx = parsedData.x - lastPos.x;
        const dy = parsedData.y - lastPos.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const maxAllowed = RUN_SPEED * tickDt * MAX_SPEED_TOLERANCE * 10; // Allow some lag buffer

        // Allow first position update without distance validation
        // This handles the case where client spawns at a different position than server default
        const isFirstPosition = !senderPlayer.hasReceivedFirstPosition;

        if (isFirstPosition || distance <= maxAllowed || distance < 5) {
          // Valid movement - update position
          senderPlayer.lastPosition = { x: parsedData.x, y: parsedData.y };
          if (parsedData.d !== undefined) senderPlayer.direction = parsedData.d;
          if (parsedData.r !== undefined) senderPlayer.isRunning = parsedData.r;

          // Mark that we've received first position
          if (isFirstPosition) {
            senderPlayer.hasReceivedFirstPosition = true;
            logger.info(
              `📍 First position from ${sender.username}: (${parsedData.x}, ${parsedData.y})`
            );
          }

          // Update AOI grid
          aoiUpdatePlayer(state.aoiGrid, sender.userId, parsedData.x, parsedData.y);

          // Store for broadcast
          state.pendingUpdates[sender.userId] = {
            userId: sender.userId,
            opCode: message.opCode,
            data: message.data as ArrayBuffer,
            reliable: message.reliable,
          };
        } else {
          // Suspicious movement - reject position but STILL update direction/running state
          // This is critical: if player stops (isRunning=false), we must update that
          // even if the position seems suspicious (could be lag/teleport)
          logger.warn(
            `⚠️ Suspicious movement from ${sender.username}: distance=${distance.toFixed(0)}, max=${maxAllowed.toFixed(0)}`
          );

          // CRITICAL FIX: Still update direction and isRunning state
          // This ensures player stops animating on other clients even if position is rejected
          if (parsedData.d !== undefined) senderPlayer.direction = parsedData.d;
          if (parsedData.r !== undefined) senderPlayer.isRunning = parsedData.r;

          // If player stopped (isRunning=false), broadcast their current position with updated state
          // This ensures other clients see the player stop animating at their last known position
          if (parsedData.r === false) {

            // Encode current position with updated running state (use encodeServerPosition)
            const stopData = encodeServerPosition(
              senderPlayer.lastPosition.x,
              senderPlayer.lastPosition.y,
              senderPlayer.direction,
              false, // isRunning = false
              0 // sequence (0 for stop event)
            );

            // Store for broadcast
            state.pendingUpdates[sender.userId] = {
              userId: sender.userId,
              opCode: message.opCode,
              data: stopData,
              reliable: true, // Stop events are critical
            };

            logger.info(
              `🛑 Player ${sender.username} stopped - broadcasting stop state at (${senderPlayer.lastPosition.x}, ${senderPlayer.lastPosition.y})`
            );
          }
        }
      }
    } else if (message.opCode === OP_MAP_CHANGE) {
      // Handle map change
      try {
        const jsonStr = nk.binaryToString(message.data as ArrayBuffer);
        const data = JSON.parse(jsonStr);
        if (data.d && data.d.map) {
          senderPlayer.currentMap = data.d.map;
        }
      } catch {
        // Ignore
      }
    }
  }

  // ============================================================================
  // PHASE 2: Server-side movement calculation for input-based players
  // ============================================================================

  for (const player of Object.values(state.players)) {
    // Only process players with active input
    // Skip if: direction is none OR player is not moving (isRunning = false means stopped)
    // Note: isRunning here means "is actively moving" not "running vs walking"
    if (player.direction === DIR_NONE || !player.isRunning) continue;

    // Calculate velocity based on direction
    const velocity = calculateVelocity(player.direction, player.isRunning);

    if (velocity.vx !== 0 || velocity.vy !== 0) {
      // Update position
      const newPos = updatePosition(
        player.lastPosition.x,
        player.lastPosition.y,
        velocity.vx,
        velocity.vy,
        tickDt
      );

      // TODO: Add collision checking here if needed
      // For now, just update position

      player.lastPosition = newPos;

      // Update AOI grid
      aoiUpdatePlayer(state.aoiGrid, player.userId, newPos.x, newPos.y);

      // Ensure this player's position is broadcast
      if (!state.pendingUpdates[player.userId]) {
        state.pendingUpdates[player.userId] = {
          userId: player.userId,
          opCode: OP_SERVER_POSITION,
          data: new ArrayBuffer(0),
          reliable: false, // Position updates can be unreliable for performance
        };
      }
    }
  }

  // ============================================================================
  // PHASE 3: Broadcast updates with AOI + Map filtering
  // ============================================================================

  for (const senderId in state.pendingUpdates) {
    const update = state.pendingUpdates[senderId];
    const senderPlayer = state.players[senderId];
    if (!senderPlayer) continue;

    const senderX = senderPlayer.lastPosition.x;
    const senderY = senderPlayer.lastPosition.y;
    const senderMap = senderPlayer.currentMap;

    // Get players within AOI radius
    const nearbyPlayerIds = aoiGetPlayersInRadius(
      state.aoiGrid,
      senderX,
      senderY,
      AOI_RADIUS
    );

    // Filter recipients: same map + within AOI + not sender
    const recipients: nkruntime.Presence[] = [];

    for (let i = 0; i < nearbyPlayerIds.length; i++) {
      const playerId = nearbyPlayerIds[i];
      if (playerId === senderId) continue;

      const player = state.players[playerId];
      if (!player) continue;

      if (player.currentMap !== senderMap) continue;

      recipients.push({
        userId: playerId,
        sessionId: player.sessionId,
        username: player.username,
        node: player.node,
      } as nkruntime.Presence);
    }

    if (recipients.length > 0) {
      // Determine data to send
      let dataToSend: ArrayBuffer;
      let opCodeToSend: number;

      if (update.opCode === OP_SERVER_POSITION) {
        // Encode authoritative position
        dataToSend = encodeServerPosition(
          senderPlayer.lastPosition.x,
          senderPlayer.lastPosition.y,
          senderPlayer.direction,
          senderPlayer.isRunning,
          senderPlayer.lastInputSequence
        );
        opCodeToSend = OP_SERVER_POSITION;
      } else {
        // Legacy: forward original data
        dataToSend = update.data;
        opCodeToSend = update.opCode;
      }

      // Create sender presence so clients know who sent this message
      // Without this, messages appear to come from 'server' with no userId
      const senderPresence: nkruntime.Presence = {
        userId: senderPlayer.userId,
        sessionId: senderPlayer.sessionId,
        username: senderPlayer.username,
        node: senderPlayer.node,
      };

      dispatcher.broadcastMessage(
        opCodeToSend,
        dataToSend,
        recipients,
        senderPresence, // Include sender so clients can identify the source
        update.reliable
      );
    }
  }

  // Clear pending updates
  state.pendingUpdates = {};

  return { state };
}

function matchTerminate(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  graceSeconds: number
): { state: MatchState } | null {
  logger.info('🛑 Match terminating...');
  return { state };
}

function matchSignal(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  dispatcher: nkruntime.MatchDispatcher,
  tick: number,
  state: MatchState,
  data: string
): { state: MatchState; data?: string } | null {
  logger.info(`📡 Match signal received: ${data}`);
  return { state };
}

// ============================================================================
// Module Initialization
// ============================================================================

function InitModule(
  ctx: nkruntime.Context,
  logger: nkruntime.Logger,
  nk: nkruntime.Nakama,
  initializer: nkruntime.Initializer
) {
  logger.info('🚀 Mall App Nakama Server Module Initialized');

  // Register RPC: Get or create waiting match (global room pattern)
  initializer.registerRpc('get_waiting_match', rpcGetWaitingMatch);
  logger.info('✅ Registered RPC: get_waiting_match');

  // Register RPC: Support Chat functions
  initializer.registerRpc('create_support_conversation', rpcCreateSupportConversation);
  logger.info('✅ Registered RPC: create_support_conversation');

  initializer.registerRpc('list_conversations', rpcListConversations);
  logger.info('✅ Registered RPC: list_conversations');

  initializer.registerRpc('mark_messages_read', rpcMarkMessagesRead);
  logger.info('✅ Registered RPC: mark_messages_read');

  // Register Match Handler
  initializer.registerMatch('eco_conscience_match', {
    matchInit: matchInit,
    matchJoinAttempt: matchJoinAttempt,
    matchJoin: matchJoin,
    matchLeave: matchLeave,
    matchLoop: matchLoop,
    matchTerminate: matchTerminate,
    matchSignal: matchSignal,
  });
  logger.info('✅ Registered Match Handler: eco_conscience_match');

  logger.info('🎮 Server module ready!');
}
