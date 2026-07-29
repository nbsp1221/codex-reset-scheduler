export class ResetrailError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(message: string, options: { code: string; exitCode?: number }) {
    super(message);
    this.name = "ResetrailError";
    this.code = options.code;
    this.exitCode = options.exitCode ?? 1;
  }
}

export class ProtocolError extends ResetrailError {
  constructor(message: string) {
    super(message, { code: "protocol_error" });
    this.name = "ProtocolError";
  }
}

export class SafetyError extends ResetrailError {
  constructor(message: string, code = "safety_refusal", exitCode = 1) {
    super(message, { code, exitCode });
    this.name = "SafetyError";
  }
}
