/**
 * Local diagnostic logger — no external telemetry (§2.1), no secret (§6).
 * The discipline boils down to two rules, enforced by construction:
 *
 *   1. the @optirelay/core modules NEVER log by themselves: they receive an
 *      injected Logger, silent by default;
 *   2. only public identifiers enter a log context — session token, block
 *      identifiers, seeds, versions, sizes. Keys, shared secrets, SAS and
 *      content are off limits.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(message: string, context?: Record<string, string | number | boolean>): void;
  info(message: string, context?: Record<string, string | number | boolean>): void;
  warn(message: string, context?: Record<string, string | number | boolean>): void;
  error(message: string, context?: Record<string, string | number | boolean>): void;
}

/** The default logger: silent. No package may write to the host's console. */
export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** Console logger for host applications that explicitly want one. */
export function consoleLogger(prefix = "orp"): Logger {
  const write = (level: LogLevel, message: string, context?: Record<string, string | number | boolean>) => {
    const line = context ? `${prefix} ${message} ${JSON.stringify(context)}` : `${prefix} ${message}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    debug: (m, c) => write("debug", m, c),
    info: (m, c) => write("info", m, c),
    warn: (m, c) => write("warn", m, c),
    error: (m, c) => write("error", m, c),
  };
}
