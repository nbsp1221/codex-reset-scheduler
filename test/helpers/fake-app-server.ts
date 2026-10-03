import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const requestLog = process.env.RESETRAIL_FAKE_REQUEST_LOG;
const epochSeconds = Number(process.env.RESETRAIL_FAKE_EPOCH_SECONDS ?? "0");
const lines = createInterface({ input: process.stdin });

function reply(id: number, result: unknown, method?: string): void {
  const send = () =>
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  if (method !== undefined && method === process.env.RESETRAIL_FAKE_HOLD_METHOD)
    return;
  send();
}

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (requestLog !== undefined) appendFileSync(requestLog, `${line}\n`, "utf8");
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
          email: "synthetic@example.invalid",
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
          availableCount: 2,
          credits: [
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
    return reply(
      message.id,
      {
        outcome: process.env.RESETRAIL_FAKE_OUTCOME ?? "reset",
      },
      message.method,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ id: message.id, error: { code: -32601 } })}\n`,
  );
});
