import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FileRetrievalLogger, NullRetrievalLogger } from '../src/retrieval/observability/logger.ts';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-logger-test-'));
}

function makeEvent(overrides = {}) {
  return {
    sessionId: 'sess-1',
    turnNumber: 1,
    timestamp: Date.now() / 1000,
    activeToolIds: ['tool-a'],
    directToolCalls: ['tool-a'],
    routerDescribes: [],
    routerProxies: [],
    ...overrides,
  };
}

describe('NullRetrievalLogger', () => {
  it('log resolves without error', async () => {
    const logger = new NullRetrievalLogger();
    await expect(logger.log(makeEvent())).resolves.toBeUndefined();
  });

  it('logRetrieval resolves without error', async () => {
    const logger = new NullRetrievalLogger();
    await expect(
      logger.logRetrieval({ sessionId: 's', query: 'q', toolCallHistory: [], queryMode: 'env' }, [], 10)
    ).resolves.toBeUndefined();
  });

  it('logAlert resolves without error', async () => {
    const logger = new NullRetrievalLogger();
    await expect(logger.logAlert('test', 'msg')).resolves.toBeUndefined();
  });
});

describe('FileRetrievalLogger', () => {
  let tmpDir;
  let logPath;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    logPath = path.join(tmpDir, 'events.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates parent directory and writes log lines', async () => {
    const nested = path.join(tmpDir, 'deep', 'nested', 'events.jsonl');
    const logger = new FileRetrievalLogger(nested);
    await logger.log(makeEvent());

    const content = fs.readFileSync(nested, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.sessionId).toBe('sess-1');
  });

  it('getLogPath returns the configured path', () => {
    const logger = new FileRetrievalLogger(logPath);
    expect(logger.getLogPath()).toBe(logPath);
  });

  it('log writes valid JSONL with all RankingEvent fields', async () => {
    const logger = new FileRetrievalLogger(logPath);
    const event = makeEvent({ turnNumber: 42, activeToolIds: ['a', 'b'] });
    await logger.log(event);

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.turnNumber).toBe(42);
    expect(parsed.activeToolIds).toEqual(['a', 'b']);
  });

  it('logAlert writes alert records that are not RankingEvents', async () => {
    const logger = new FileRetrievalLogger(logPath);
    await logger.logAlert('high_latency', 'Pipeline slow', { ms: 500 });

    const lines = fs.readFileSync(logPath, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe('alert');
    expect(parsed.alertName).toBe('high_latency');
    expect(parsed.details).toEqual({ ms: 500 });
  });

  describe('readRankingEvents', () => {
    it('returns empty array when file does not exist', async () => {
      const logger = new FileRetrievalLogger(path.join(tmpDir, 'nonexistent.jsonl'));
      const events = await logger.readRankingEvents(0);
      expect(events).toEqual([]);
    });

    it('reads ranking events filtering by sinceEpochSeconds', async () => {
      const logger = new FileRetrievalLogger(logPath);
      const old = makeEvent({ timestamp: 1000 });
      const recent = makeEvent({ timestamp: 2000, turnNumber: 2 });
      await logger.log(old);
      await logger.log(recent);

      const events = await logger.readRankingEvents(1500);
      expect(events).toHaveLength(1);
      expect(events[0].turnNumber).toBe(2);
    });

    it('filters out alert records from ranking events', async () => {
      const logger = new FileRetrievalLogger(logPath);
      await logger.log(makeEvent({ timestamp: 1000 }));
      await logger.logAlert('test', 'msg');
      await logger.log(makeEvent({ timestamp: 2000, turnNumber: 5 }));

      const events = await logger.readRankingEvents(0);
      expect(events).toHaveLength(2);
      expect(events.every(e => e.sessionId === 'sess-1')).toBe(true);
    });

    it('uses incremental cache — second call does not re-parse old data', async () => {
      const logger = new FileRetrievalLogger(logPath);
      await logger.log(makeEvent({ timestamp: 1000, turnNumber: 1 }));

      const first = await logger.readRankingEvents(0);
      expect(first).toHaveLength(1);

      // Append more data
      await logger.log(makeEvent({ timestamp: 2000, turnNumber: 2 }));

      const second = await logger.readRankingEvents(0);
      expect(second).toHaveLength(2);
      expect(second[1].turnNumber).toBe(2);
    });

    it('handles file truncation/rotation by resetting cache', async () => {
      const logger = new FileRetrievalLogger(logPath);
      await logger.log(makeEvent({ timestamp: 1000, turnNumber: 1 }));
      await logger.log(makeEvent({ timestamp: 2000, turnNumber: 2 }));

      // Prime the cache
      const first = await logger.readRankingEvents(0);
      expect(first).toHaveLength(2);

      // Simulate log rotation: truncate the file and write new data
      fs.writeFileSync(logPath, '');
      await logger.log(makeEvent({ timestamp: 3000, turnNumber: 3 }));

      const afterRotation = await logger.readRankingEvents(0);
      expect(afterRotation).toHaveLength(1);
      expect(afterRotation[0].turnNumber).toBe(3);
    });

    it('prunes expired events from cache head', async () => {
      const logger = new FileRetrievalLogger(logPath);
      await logger.log(makeEvent({ timestamp: 100 }));
      await logger.log(makeEvent({ timestamp: 200, turnNumber: 2 }));
      await logger.log(makeEvent({ timestamp: 300, turnNumber: 3 }));

      // First call loads all into cache
      const all = await logger.readRankingEvents(0);
      expect(all).toHaveLength(3);

      // Second call with higher threshold prunes old events
      const recent = await logger.readRankingEvents(250);
      expect(recent).toHaveLength(1);
      expect(recent[0].turnNumber).toBe(3);
    });

    it('handles malformed JSON lines gracefully', async () => {
      const logger = new FileRetrievalLogger(logPath);
      // Write a valid event, then garbage, then another valid event
      const valid1 = JSON.stringify(makeEvent({ timestamp: 1000, turnNumber: 1 }));
      const valid2 = JSON.stringify(makeEvent({ timestamp: 2000, turnNumber: 2 }));
      fs.writeFileSync(logPath, `${valid1}\nnot valid json\n${valid2}\n`);

      const events = await logger.readRankingEvents(0);
      expect(events).toHaveLength(2);
    });

    it('skips lines with group=shadow', async () => {
      const logger = new FileRetrievalLogger(logPath);
      const shadowLine = JSON.stringify({
        ...makeEvent({ timestamp: 1000 }),
        group: 'shadow',
      });
      const normalLine = JSON.stringify(makeEvent({ timestamp: 2000, turnNumber: 5 }));
      fs.writeFileSync(logPath, `${shadowLine}\n${normalLine}\n`);

      const events = await logger.readRankingEvents(0);
      expect(events).toHaveLength(1);
      expect(events[0].turnNumber).toBe(5);
    });
  });
});
