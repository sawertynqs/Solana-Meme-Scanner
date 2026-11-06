import WebSocket from "ws";
import { MONITORED_PROGRAMS } from "../constants.js";
import { logger } from "../logger.js";

export interface StreamSignature {
  signature: string;
  programId: string;
  slot: number;
}

export class SolanaLogMonitor {
  private socket: WebSocket | null = null;
  private stopped = true;
  private connected = false;
  private requestId = 0;
  private readonly subscriptions = new Map<number, string>();
  private readonly requestPrograms = new Map<number, string>();

  constructor(
    private readonly websocketUrl: string,
    private readonly onSignature: (event: StreamSignature) => void,
  ) {}

  get isConnected(): boolean {
    return this.connected;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    this.connected = false;
    this.socket?.close(1000, "scanner stopping");
    this.socket = null;
  }

  private async connectLoop(): Promise<void> {
    let retryMs = 1_000;
    while (!this.stopped) {
      try {
        await this.runSocket();
        retryMs = 1_000;
      } catch (error) {
        logger.warn({ err: error }, "Helius WebSocket disconnected");
      }
      if (this.stopped) return;
      const jitter = Math.floor(Math.random() * 500);
      logger.warn({ retryInMs: retryMs + jitter }, "Reconnecting Solana log monitor");
      await new Promise((resolve) => setTimeout(resolve, retryMs + jitter));
      retryMs = Math.min(30_000, retryMs * 2);
    }
  }

  private runSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(this.websocketUrl, { handshakeTimeout: 15_000 });
      this.socket = socket;
      let settled = false;
      let isAlive = true;
      let hasOpened = false;
      const settle = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearInterval(pingTimer);
        clearTimeout(openTimer);
        this.connected = false;
        this.subscriptions.clear();
        this.requestPrograms.clear();
        if (error) reject(error);
        else resolve();
      };

      const openTimer = setTimeout(() => {
        if (!hasOpened) socket.terminate();
      }, 20_000);
      const pingTimer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        if (!isAlive) {
          socket.terminate();
          return;
        }
        isAlive = false;
        socket.ping();
      }, 60_000);
      pingTimer.unref();

      socket.on("open", () => {
        hasOpened = true;
        clearTimeout(openTimer);
        this.connected = true;
        logger.info({ programCount: MONITORED_PROGRAMS.length }, "Connected to Helius logs WebSocket");
        for (const program of MONITORED_PROGRAMS) {
          const id = ++this.requestId;
          this.requestPrograms.set(id, program.id);
          socket.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "logsSubscribe",
              params: [{ mentions: [program.id] }, { commitment: "confirmed" }],
            }),
          );
        }
      });

      socket.on("pong", () => {
        isAlive = true;
      });

      socket.on("message", (raw) => {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          logger.warn("Ignoring malformed Helius WebSocket message");
          return;
        }

        if (typeof message.id === "number" && this.requestPrograms.has(message.id)) {
          const programId = this.requestPrograms.get(message.id);
          this.requestPrograms.delete(message.id);
          if (message.error) {
            logger.error({ programId, rpcError: message.error }, "Helius subscription was rejected");
            socket.close(1011, "subscription rejected");
            return;
          }
          if (typeof message.result === "number" && programId) {
            this.subscriptions.set(message.result, programId);
          }
          return;
        }

        if (message.method !== "logsNotification") return;
        const params = message.params as
          | {
              subscription?: number;
              result?: {
                context?: { slot?: number };
                value?: { signature?: string; err?: unknown };
              };
            }
          | undefined;
        const subscription = params?.subscription;
        const programId = subscription ? this.subscriptions.get(subscription) : undefined;
        const value = params?.result?.value;
        const signature = value?.signature;
        const slot = params?.result?.context?.slot;
        if (!programId || !signature || typeof slot !== "number" || value?.err) return;
        this.onSignature({ signature, programId, slot });
      });

      socket.on("error", (error) => {
        logger.warn({ err: error.message }, "Helius WebSocket error");
        settle(error);
        socket.terminate();
      });
      socket.on("close", (code, reason) => {
        if (this.socket === socket) this.socket = null;
        settle(
          this.stopped
            ? undefined
            : new Error(`WebSocket closed (${code}): ${reason.toString().slice(0, 120)}`),
        );
      });
    });
  }
}
