// Type definitions for Nakama Server Runtime
// These types are provided by Nakama at runtime

declare namespace nkruntime {
  interface Context {
    env: { [key: string]: string };
    executionMode: string;
    headers: { [key: string]: string[] };
    queryParams: { [key: string]: string[] };
    userId: string;
    username: string;
    vars: { [key: string]: string };
    userSessionExp: number;
    sessionId: string;
  }

  interface Logger {
    debug(message: string, ...args: any[]): void;
    info(message: string, ...args: any[]): void;
    warn(message: string, ...args: any[]): void;
    error(message: string, ...args: any[]): void;
  }

  interface Nakama {
    matchList(
      limit: number,
      authoritative?: boolean,
      label?: string,
      minSize?: number,
      maxSize?: number,
      query?: string
    ): Match[];

    matchCreate(module: string, params?: any): string;

    rpc(
      ctx: Context,
      id: string,
      userId: string,
      username: string,
      vars: { [key: string]: string },
      expiry: number,
      sessionId: string,
      clientIp: string,
      clientPort: string,
      payload: string
    ): string;

    binaryToString(data: ArrayBuffer): string;
  }

  interface Initializer {
    registerRpc(id: string, fn: RpcFunction): void;
    registerMatch(name: string, handlers: MatchHandler): void;
  }

  interface RpcFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      payload: string
    ): string;
  }

  interface Match {
    matchId: string;
    authoritative: boolean;
    label: string;
    size: number;
  }

  interface Presence {
    userId: string;
    sessionId: string;
    username: string;
    node: string;
  }

  interface MatchHandler {
    matchInit: MatchInitFunction;
    matchJoinAttempt: MatchJoinAttemptFunction;
    matchJoin: MatchJoinFunction;
    matchLeave: MatchLeaveFunction;
    matchLoop: MatchLoopFunction;
    matchTerminate: MatchTerminateFunction;
    matchSignal: MatchSignalFunction;
  }

  interface MatchInitFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      params: { [key: string]: string }
    ): { state: any; tickRate: number; label: string };
  }

  interface MatchJoinAttemptFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      presence: Presence,
      metadata: { [key: string]: any }
    ): { state: any; accept: boolean; rejectMessage?: string } | null;
  }

  interface MatchJoinFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      presences: Presence[]
    ): { state: any } | null;
  }

  interface MatchLeaveFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      presences: Presence[]
    ): { state: any } | null;
  }

  interface MatchLoopFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      messages: MatchMessage[]
    ): { state: any } | null;
  }

  interface MatchTerminateFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      graceSeconds: number
    ): { state: any } | null;
  }

  interface MatchSignalFunction {
    (
      ctx: Context,
      logger: Logger,
      nk: Nakama,
      dispatcher: MatchDispatcher,
      tick: number,
      state: any,
      data: string
    ): { state: any; data?: string } | null;
  }

  interface MatchDispatcher {
    broadcastMessage(
      opCode: number,
      data: string | ArrayBuffer,
      presences: Presence[] | null,
      sender: Presence | null,
      reliable: boolean
    ): void;
  }

  interface MatchMessage {
    sender: Presence;
    opCode: number;
    data: ArrayBuffer;
    reliable: boolean;
    receiveTime: number;
  }

  type InitModule = (
    ctx: Context,
    logger: Logger,
    nk: Nakama,
    initializer: Initializer
  ) => void;
}
