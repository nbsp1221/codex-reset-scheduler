import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

// Opt-in file state for separate CLI/worker processes in native product QA.
const stateFile = process.env.RESETRAIL_FAKE_STATE_FILE;
type Fixture = {
  nonce: string;
  accountEmail: string;
  requestLog: string;
  credits: {
    id: string;
    resetType: string;
    status: string;
    grantedAt: number;
    expiresAt: number;
    title: string;
    description: string;
  }[];
  results: Record<string, { creditId: string; outcome: string }>;
};
function fixture(): Fixture | null {
  return stateFile === undefined
    ? null
    : (JSON.parse(readFileSync(stateFile, "utf8")) as Fixture);
}
const native = fixture();
const startedAt = new Date().toISOString();
const identity =
  native === null
    ? "legacy-fixture"
    : process.platform === "win32"
      ? spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
          ],
          { encoding: "utf8", windowsHide: true },
        ).stdout.trim()
      : `uid:${process.getuid?.()}`;
const identityHash = createHash("sha256").update(identity).digest("hex");
const requestLog = native?.requestLog ?? process.env.RESETRAIL_FAKE_REQUEST_LOG;
const epochSeconds = Number(process.env.RESETRAIL_FAKE_EPOCH_SECONDS ?? "0");

function reply(id: number, result: unknown, method?: string): void {
  const send = () =>
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  if (method !== undefined && method === process.env.RESETRAIL_FAKE_HOLD_METHOD)
    return;
  send();
}

export function startFakeAppServer(
  observeRequest?: (
    message: Record<string, unknown>,
  ) => Record<string, unknown> | undefined,
): void {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    const message = JSON.parse(line) as Record<string, unknown>;
    const current = fixture();
    // The optional test observer runs synchronously at receipt, before any effect.
    const observed = observeRequest?.(message);
    if (requestLog !== undefined)
      appendFileSync(
        requestLog,
        `${JSON.stringify(current === null ? message : { ...message, nonce: current.nonce, pid: process.pid, parentPid: process.ppid, identityHash, startedAt, receivedAt: new Date().toISOString(), ...observed })}\n`,
        "utf8",
      );
    if (typeof message.id !== "number" || typeof message.method !== "string")
      return;
    if (message.method === "initialize")
      return reply(message.id, { userAgent: "fake" }, message.method);
    if (message.method === "account/read") {
      return reply(
        message.id,
        {
          account: {
            type: "chatgpt",
            email: current?.accountEmail ?? "synthetic@example.invalid",
            planType: "pro",
          },
          requiresOpenaiAuth: true,
        },
        message.method,
      );
    }
    if (message.method === "account/rateLimits/read") {
      return reply(
        message.id,
        {
          ordinaryUsageAllowed: false,
          accountId: "synthetic-account",
          rateLimitUpsell: null,
          rateLimits: {
            limitId: "codex",
            limitName: null,
            rateLimitReachedType: null,
            primary: {
              usedPercent: 50,
              windowDurationMins: 300,
              resetsAt: epochSeconds + 20_000,
            },
            secondary: null,
          },
          rateLimitsByLimitId: null,
          rateLimitResetCredits: {
            availableCount: current?.credits.length ?? 2,
            credits: current?.credits ?? [
              {
                id: "synthetic-credit-a",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: epochSeconds + 1_000,
                expiresAt: epochSeconds + 10_000,
                title: "Synthetic reset A",
                description: "Fixture only",
              },
              {
                id: "synthetic-credit-b",
                resetType: "codexRateLimits",
                status: "available",
                grantedAt: epochSeconds + 1_100,
                expiresAt: epochSeconds + 11_000,
                title: "Synthetic reset B",
                description: "Fixture only",
              },
            ],
          },
        },
        message.method,
      );
    }
    if (message.method === "account/rateLimitResetCredit/consume") {
      if (process.env.RESETRAIL_FAKE_REFUSE_CONSUME === "1") {
        process.stdout.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601 } })}\n`,
        );
        return;
      }
      if (current !== null && stateFile !== undefined) {
        const params = message.params as {
          creditId: string;
          idempotencyKey: string;
        };
        const previous = current.results[params.idempotencyKey];
        if (previous !== undefined && previous.creditId !== params.creditId)
          throw new Error(
            "A fake request UUID cannot be rebound to another target.",
          );
        const outcome =
          previous?.outcome ??
          (current.credits.some((c) => c.id === params.creditId)
            ? "reset"
            : "noCredit");
        current.results[params.idempotencyKey] = {
          creditId: params.creditId,
          outcome,
        };
        if (outcome === "reset")
          current.credits = current.credits.filter(
            (c) => c.id !== params.creditId,
          );
        writeFileSync(stateFile, JSON.stringify(current), { mode: 0o600 });
        return reply(message.id, { outcome }, message.method);
      }
      return reply(
        message.id,
        { outcome: process.env.RESETRAIL_FAKE_OUTCOME ?? "reset" },
        message.method,
      );
    }
    process.stdout.write(
      `${JSON.stringify({ id: message.id, error: { code: -32601 } })}\n`,
    );
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
)
  startFakeAppServer();
