import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const requestLog = process.env.RESETRAIL_FAKE_REQUEST_LOG;
const lines = createInterface({ input: process.stdin });

function reply(id: number, result: unknown, method?: string): void {
  const send = () =>
    process.stdout.write(`${JSON.stringify({ id, result })}\n`);
  if (method === process.env.RESETRAIL_FAKE_DELAY_METHOD) {
    setTimeout(send, Number(process.env.RESETRAIL_FAKE_DELAY_MS ?? "0"));
  } else send();
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
        rateLimits: {
          primary: {
            usedPercent: 50,
            windowDurationMins: 300,
            resetsAt: 20_000,
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
              grantedAt: 1_000,
              expiresAt: 10_000,
              title: "Synthetic reset A",
              description: "Fixture only",
            },
            {
              id: "synthetic-credit-b",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_100,
              expiresAt: 11_000,
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
