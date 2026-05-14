import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RankingEvent, RetrievalContext, ScoredTool } from "../models.js";

export interface RetrievalLogger {
  log(event: RankingEvent): Promise<void>;
  logRetrieval?(
    context: RetrievalContext,
    results: ScoredTool[],
    latencyMs: number
  ): Promise<void>;
  logRetrievalMiss?(toolName: string, context: RetrievalContext): Promise<void>;
  logToolSequence?(sessionId: string, toolA: string, toolB: string): Promise<void>;
  logAlert?(alertName: string, message: string, details?: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
}

export class NullRetrievalLogger implements RetrievalLogger {
  async log(_event: RankingEvent): Promise<void> {}
  async logRetrieval(
    _context: RetrievalContext,
    _results: ScoredTool[],
    _latencyMs: number
  ): Promise<void> {}
  async logRetrievalMiss(_toolName: string, _context: RetrievalContext): Promise<void> {}
  async logToolSequence(
    _sessionId: string,
    _toolA: string,
    _toolB: string
  ): Promise<void> {}
  async logAlert(
    _alertName: string,
    _message: string,
    _details?: Record<string, unknown>
  ): Promise<void> {}
}

export class FileRetrievalLogger implements RetrievalLogger {
  private readonly _path: string;

  constructor(logPath: string) {
    this._path = logPath;
    // Ensure parent directory exists
    mkdir(dirname(logPath), { recursive: true }).catch(() => {});
  }

  async log(event: RankingEvent): Promise<void> {
    const line = JSON.stringify(event, (_, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    try {
      await appendFile(this._path, line + "\n", "utf-8");
    } catch (err) {
      console.error("FileRetrievalLogger.write error:", err);
    }
  }

  async logAlert(
    alertName: string,
    message: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    const record = {
      type: "alert",
      alertName,
      message,
      details: details ?? {},
      timestamp: Date.now() / 1000,
    };
    try {
      await appendFile(
        this._path,
        JSON.stringify(record, (_, v) =>
          typeof v === "bigint" ? v.toString() : v
        ) + "\n",
        "utf-8"
      );
    } catch (err) {
      console.error("FileRetrievalLogger.logAlert write error:", err);
    }
  }
}

