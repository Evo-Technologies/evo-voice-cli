export const EXIT = {
  OK: 0,
  ERR: 1,
  USAGE: 2,
  EMPTY: 3,
  AUTH: 4,
  NOT_FOUND: 5,
  FORBIDDEN: 6,
  RATE_LIMIT: 7,
  RETRYABLE: 8,
  NOT_IMPLEMENTED: 9,
  CONFIG: 10,
  CONFIRMATION_REQUIRED: 11,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export const EXIT_DESCRIPTIONS: Record<ExitCode, string> = {
  [EXIT.OK]: "success",
  [EXIT.ERR]: "generic error",
  [EXIT.USAGE]: "usage error (bad flags or args)",
  [EXIT.EMPTY]: "empty result set",
  [EXIT.AUTH]: "auth required or invalid credentials",
  [EXIT.NOT_FOUND]: "resource not found",
  [EXIT.FORBIDDEN]: "forbidden",
  [EXIT.RATE_LIMIT]: "rate limited",
  [EXIT.RETRYABLE]: "transient upstream error, safe to retry",
  [EXIT.NOT_IMPLEMENTED]: "command not implemented in this phase",
  [EXIT.CONFIG]: "config error",
  [EXIT.CONFIRMATION_REQUIRED]: "prod write requires two-phase confirmation; show summary, then run `evov confirm <token>`",
};

export class CliError extends Error {
  constructor(public readonly code: ExitCode, message: string) {
    super(message);
  }
}
