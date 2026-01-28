// Nakama Server Module - Main Entry Point
// This module handles multiplayer match creation and management for Mall App

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
}

interface MatchPlayer {
  userId: string;
  username: string;
  joinedAt: number;
  currentMap: string;
  lastPosition: { x: number; y: number };
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

  const MAX_PLAYERS = 15;
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
  logger.info('🎮 Match initializing...');

  const label = params.label || 'eco_conscience_global';
  const maxPlayers = parseInt(params.maxPlayers || '15');

  const state: MatchState = {
    label: label,
    maxPlayers: maxPlayers,
    players: {},
    createdAt: Date.now(),
  };

  logger.info(`✅ Match initialized: ${label} (max ${maxPlayers} players)`);

  return {
    state: state,
    tickRate: 10, // 10 ticks per second
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

    // Add player to state
    state.players[presence.userId] = {
      userId: presence.userId,
      username: presence.username,
      joinedAt: Date.now(),
      currentMap: 'outdoors',
      lastPosition: { x: 96, y: 384 }, // Default spawn position
    };

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
    const joinNotification = {
      type: 'player_joined',
      player: state.players[presence.userId],
    };

    dispatcher.broadcastMessage(
      2, // OpCode for player joined
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
  // Process incoming messages and relay them to other players

  for (const message of messages) {
    const sender = message.sender;

    // IMPORTANT: Relay message to ALL other players (exclude sender)
    // This is required for multiplayer - Nakama does NOT auto-relay!
    dispatcher.broadcastMessage(
      message.opCode,
      message.data,
      null, // Send to all
      sender, // Exclude sender
      message.reliable
    );

    // Try to parse and update state (for server-side tracking)
    try {
      const data = JSON.parse(
        nk.binaryToString(message.data as ArrayBuffer)
      );

      // Update player's last known position/map
      if (state.players[sender.userId]) {
        if (data.x !== undefined && data.y !== undefined) {
          state.players[sender.userId].lastPosition = {
            x: data.x,
            y: data.y,
          };
        }

        if (data.mapName) {
          state.players[sender.userId].currentMap = data.mapName;
        }
      }
    } catch (error) {
      // Ignore parsing errors for binary messages
      // Binary messages are still relayed above
    }
  }

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
