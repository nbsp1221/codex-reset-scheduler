import { SafetyError } from "../domain/errors.js";

export function xmlEscape(value: string): string {
  rejectControlCharacters(value);
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function systemdQuote(value: string): string {
  rejectControlCharacters(value);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

export function windowsQuoteArgument(value: string): string {
  rejectControlCharacters(value);
  if (value.length === 0) return '""';
  if (!/[\s"]/u.test(value)) return value;
  let result = '"';
  let backslashes = 0;
  for (const character of value) {
    if (character === "\\") {
      backslashes += 1;
      continue;
    }
    if (character === '"') {
      result += "\\".repeat(backslashes * 2 + 1);
      result += '"';
      backslashes = 0;
      continue;
    }
    result += "\\".repeat(backslashes);
    result += character;
    backslashes = 0;
  }
  result += "\\".repeat(backslashes * 2);
  return `${result}"`;
}

function rejectControlCharacters(value: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || codePoint === 0x7f) {
      throw new SafetyError(
        "Scheduler values must not contain control characters.",
        "unsafe_argument",
      );
    }
  }
}
