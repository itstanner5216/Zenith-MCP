import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { RankingEvent, RetrievalContext, ScoredTool } from "../models.js";

// Structural validator for RankingEvent records read back from the JSONL log.
// Checks the discriminating required fields — RankingEvent has many fields, but
// these three are enough to distinguish a real ranking-event line from alerts,
// shadow records, or other JSONL payloads that share the file. Lines written by
// this logger's own `log()` method always satisfy this guard. Parameter is
// `unknown` so the predicate `obj is RankingEvent` is structurally valid.
function isRankingEventShape(obj: unknown): obj is RankingEvent {
  if (typeof obj !== "object" || obj === null) return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.sessionId === "string" &&
    typeof r.turnNumber === "number" &&
    typeof r.timestamp === "number" &&
    Array.isArray(r.activeToolIds) &&
    Array.isArray(r.directToolCalls) &&
    Array.isArray(r.routerDescribes) &&
    Array.isArray(r.routerProxies)
  );
}

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
  private readonly _ready: Promise<void>;

  constructor(logPath: string) {
    this._path = logPath;
    this._ready = mkdir(dirname(logPath), { recursive: true })
      .then(() => undefined)
      .catch(() => undefined);
  }

  getLogPath(): string {
    return this._path;
  }

  private async _appendLine(line: string): Promise<void> {
    await this._ready;
    try {
      await appendFile(this._path, line + "\n", "utf-8");
    } catch (err) {
      console.error("FileRetrievalLogger.write error:", err);
    }
  }

  async log(event: RankingEvent): Promise<void> {
    const line = JSON.stringify(event, (_, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    await this._appendLine(line);
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
    const line = JSON.stringify(record, (_, v) =>
      typeof v === "bigint" ? v.toString() : v
    );
    await this._appendLine(line);
  }

  async readRankingEvents(sinceEpochSeconds: number): Promise<RankingEvent[]> {
    await this._ready;
    let text: string;
    try {
      text = await readFile(this._path, "utf-8");
    } catch {
      return [];
    }

    const events: RankingEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (obj.type === "alert" || obj.group === "shadow") continue;
      const ts = typeof obj.timestamp === "number" ? obj.timestamp : undefined;
      if (ts === undefined || ts < sinceEpochSeconds) continue;
      if (isRankingEventShape(parsed)) events.push(parsed);
    }
    return events;
  }
}
