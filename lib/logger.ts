import pino from "pino"

// Structured logging so container/log-aggregator output is greppable/jq-able
// instead of the ad hoc `console.*` calls this replaces. Deliberately reads
// process.env directly (not lib/env.ts's validateEnv()) — several call sites
// need to log *during* env validation itself, before a parsed env exists.
export const logger = pino({
  level:
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "production" ? "info" : "debug"),
  // Pretty-printed only in development; production always emits raw JSON to
  // stdout so it's directly consumable by `docker logs` / a log aggregator.
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss" },
        },
})

type LogContext = Record<string, unknown>

export function logDebug(msg: string, context?: LogContext): void {
  logger.debug(context ?? {}, msg)
}

export function logInfo(msg: string, context?: LogContext): void {
  logger.info(context ?? {}, msg)
}

export function logWarn(msg: string, context?: LogContext): void {
  logger.warn(context ?? {}, msg)
}

export function logError(msg: string, context?: LogContext): void {
  logger.error(context ?? {}, msg)
}
