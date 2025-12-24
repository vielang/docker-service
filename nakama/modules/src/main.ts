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
