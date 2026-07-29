import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { ProtocolError, SafetyError } from "../domain/errors.js";
import type {
  ChatgptAccount,
  ConsumeOutcome,
  RateLimitsSnapshot,
} from "../domain/types.js";
import {
  decodeAccountResponse,
  decodeConsumeResponse,
  decodeRateLimitsResponse,
} from "./decoders.js";

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type AppServerLaunch = Readonly<{
  executable: string;
  arguments: readonly string[];
  environment?: NodeJS.ProcessEnv;
  deadlineAtEpochMilliseconds?: number;
}>;

export class AppServerClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<number, Pending>();
  #requestId = 0;
  #stderr = "";
  #closed = false;
  readonly #deadlineAtEpochMilliseconds: number | undefined;

  private constructor(launch: AppServerLaunch) {
    this.#deadlineAtEpochMilliseconds = launch.deadlineAtEpochMilliseconds;
    this.#child = spawn(launch.executable, [...launch.arguments], {
      env: launch.environment ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-4_000);
    });
    this.#child.stdin.on("error", () => undefined);
    const lines = createInterface({ input: this.#child.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    this.#child.on("error", (error) =>
      this.#rejectAll(`Failed to start app-server: ${error.message}`),
    );
    this.#child.on("exit", (code, signal) => {
      this.#rejectAll(
        `App-server exited before replying (code=${String(code)}, signal=${String(signal)}).`,
      );
    });
  }

  static async connect(launch: AppServerLaunch): Promise<AppServerClient> {
    const client = new AppServerClient(launch);
    try {
      await client.#request("initialize", {
        clientInfo: { name: "resetrail", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      client.#notify("initialized", null);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async readAccount(): Promise<ChatgptAccount> {
    return decodeAccountResponse(
      await this.#request("account/read", { refreshToken: false }),
    );
  }

  async readRateLimits(): Promise<RateLimitsSnapshot> {
    return decodeRateLimitsResponse(
      await this.#request("account/rateLimits/read", null),
    );
  }

  async consumeExactCredit(
    creditId: string,
    idempotencyKey: string,
  ): Promise<ConsumeOutcome> {
    if (creditId.trim().length === 0) {
      throw new SafetyError(
        "An exact non-empty credit ID is required.",
        "missing_credit_id",
      );
    }
    if (idempotencyKey.trim().length === 0) {
      throw new SafetyError(
        "A non-empty idempotency key is required.",
        "missing_idempotency_key",
      );
    }
    return decodeConsumeResponse(
      await this.#request("account/rateLimitResetCredit/consume", {
        creditId,
        idempotencyKey,
      }),
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#child.stdin.end();
    if (this.#child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#child.kill("SIGTERM");
        resolve();
      }, 2_000);
      this.#child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  #handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      return;
    }
    if (
      typeof message !== "object" ||
      message === null ||
      Array.isArray(message)
    )
      return;
    const object = message as Record<string, unknown>;
    if (typeof object.id !== "number") return;
    const pending = this.#pending.get(object.id);
    if (pending === undefined) return;
    this.#pending.delete(object.id);
    clearTimeout(pending.timeout);
    if (object.error !== undefined) {
      pending.reject(
        new ProtocolError("App-server returned a JSON-RPC error."),
      );
    } else {
      pending.resolve(object.result);
    }
  }

  #notify(method: string, params: unknown): void {
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  #request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed)
      return Promise.reject(new ProtocolError("App-server client is closed."));
    const remaining =
      this.#deadlineAtEpochMilliseconds === undefined
        ? 30_000
        : this.#deadlineAtEpochMilliseconds - Date.now();
    if (remaining <= 0)
      return Promise.reject(
        new ProtocolError("App-server worker deadline was reached."),
      );
    const id = ++this.#requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => {
          this.#pending.delete(id);
          reject(new ProtocolError(`App-server request timed out: ${method}.`));
        },
        Math.min(30_000, remaining),
      );
      this.#pending.set(id, { resolve, reject, timeout });
      this.#child.stdin.write(
        `${JSON.stringify({ id, method, params })}\n`,
        (error) => {
          if (error === null || error === undefined) return;
          const current = this.#pending.get(id);
          if (current === undefined) return;
          this.#pending.delete(id);
          clearTimeout(current.timeout);
          reject(
            new ProtocolError(`Failed to write app-server request: ${method}.`),
          );
        },
      );
    });
  }

  #rejectAll(message: string): void {
    const suffix =
      this.#stderr.trim().length === 0
        ? ""
        : " See sanitized diagnostics with doctor.";
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new ProtocolError(`${message}${suffix}`));
    }
    this.#pending.clear();
  }
}
