#!/usr/bin/env node
// ---------------------------------------------------------------------------
// http-server.js — Native HTTP entrypoint for MCP Streamable HTTP + legacy SSE
//
// Usage:
//   node dist/server/http.js [allowed-directory ...] [--port=3100] [--host=0.0.0.0]
//
// Supports:
//   POST /mcp          — Streamable HTTP (initialize + messages)
//   GET  /mcp          — Streamable HTTP (SSE notification stream)
//   DELETE /mcp        — Streamable HTTP (session teardown)
//   GET  /sse          — Legacy SSE transport
//   POST /messages     — Legacy SSE message endpoint
//   GET  /health       — Simple health check
// ---------------------------------------------------------------------------

import { randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createFilesystemContext } from '../core/lib.js';
import {
    createFilesystemServer,
    attachRootsHandlers,
    resolveInitialAllowedDirectories,
    validateDirectories,
} from '../core/server.js';
import { ripgrepAvailable } from '../core/shared.js';

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let port = 3100;
let host = '0.0.0.0';
const dirArgs = [];
const API_KEY = process.env.ZENITH_MCP_API_KEY || process.env.MCP_BRIDGE_API_KEY || process.env.COMMANDER_API_KEY;

if (!API_KEY) {
    console.error('FATAL: ZENITH_MCP_API_KEY, MCP_BRIDGE_API_KEY, or COMMANDER_API_KEY must be set');
    process.exit(1);
}

for (const arg of args) {
    if (arg.startsWith('--port=')) {
        port = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--host=')) {
        host = arg.split('=')[1];
    } else if (!arg.startsWith('--')) {
        dirArgs.push(arg);
    }
}

// Resolve and validate the baseline allowed directories from CLI args.
// Each HTTP session gets its OWN copy of these as the starting point;
// MCP roots negotiations may widen or narrow a session's dirs independently.
const baselineAllowedDirs = await resolveInitialAllowedDirectories(dirArgs);
if (baselineAllowedDirs.length > 0) {
    await validateDirectories(baselineAllowedDirs);
}

// ---------------------------------------------------------------------------
// Session storage — keyed by session ID, stores transport + cleanup handles.
// Transports from different protocol types are never mixed.
// ---------------------------------------------------------------------------
const sessions = new Map();
// session id -> { type: 'streamable'|'sse', transport, server, ctx }

function removeSession(sessionId) {
    const entry = sessions.get(sessionId);
    if (entry) {
        sessions.delete(sessionId);
        console.error(`[session:${sessionId.slice(0, 8)}] closed (${entry.type})`);
    }
}

// ---------------------------------------------------------------------------
// Session reaper — close sessions idle longer than SESSION_TTL_MS.
// Prevents unbounded memory growth from clients that connect and vanish.
// ---------------------------------------------------------------------------
const SESSION_TTL_MS = parseInt(process.env.SESSION_TTL_MS || '1800000', 10); // 30 min default
const REAP_INTERVAL_MS = 60_000; // check every 60s

setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions) {
        if (now - entry.lastSeenAt > SESSION_TTL_MS) {
            console.error(`[session:${sessionId.slice(0, 8)}] reaped (idle > ${SESSION_TTL_MS / 1000}s)`);
            try { entry.transport.close(); } catch { /* best effort */ }
            sessions.delete(sessionId);
        }
    }
}, REAP_INTERVAL_MS).unref(); // unref so the timer doesn't keep the process alive

// ---------------------------------------------------------------------------
// Helper: spin up a fresh ctx + server for a new session
// ---------------------------------------------------------------------------
function createSessionPair() {
    const ctx = createFilesystemContext([...baselineAllowedDirs]);
    const server = createFilesystemServer(ctx);
    attachRootsHandlers(server, ctx);
    return { ctx, server };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '4mb' }));

function unauthorized(res) {
    return res.status(401).json({ error: 'Unauthorized' });
}

app.use((req, res, next) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
        return unauthorized(res);
    }
    const token = auth.slice(7);
    const tokenBuf = Buffer.from(token);
    const keyBuf = Buffer.from(API_KEY);
    if (tokenBuf.length !== keyBuf.length || !timingSafeEqual(tokenBuf, keyBuf)) {
        return unauthorized(res);
    }
    next();
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        sessions: sessions.size,
        baselineDirs: baselineAllowedDirs.length,
        sessionTtlSeconds: SESSION_TTL_MS / 1000,
    });
});

// ── Streamable HTTP: POST /mcp ────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // ── Existing session: forward the message ──
    if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry || entry.type !== 'streamable') {
            res.status(400).json({ error: 'Unknown or mismatched session' });
            return;
        }
        try {
            entry.lastSeenAt = Date.now();
            await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
            console.error(`[session:${sessionId.slice(0, 8)}] POST error:`, err);
            if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
        }
        return;
    }

    // ── New session: must be an initialize request ──
    if (!isInitializeRequest(req.body)) {
        res.status(400).json({ error: 'First request must be an initialize request (no Mcp-Session-Id header)' });
        return;
    }

    const { ctx, server } = createSessionPair();

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });

    // Wire up cleanup on transport close
    transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) removeSession(sid);
    };

    await server.connect(transport);

    // Handle the initialize request — this sets transport.sessionId
    await transport.handleRequest(req, res, req.body);

    // Store the session — sync ctx._sessionId to the transport's assigned ID.
    const sid = transport.sessionId;
    if (sid) {
        ctx._sessionId = sid;
        sessions.set(sid, { type: 'streamable', transport, server, ctx, lastSeenAt: Date.now() });
        console.error(`[session:${sid.slice(0, 8)}] opened (streamable)`);
    }
});

// ── Streamable HTTP: GET /mcp (SSE notification stream) ───────────────────────
app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }
    const entry = sessions.get(sessionId);
    if (!entry || entry.type !== 'streamable') {
        res.status(400).json({ error: 'Unknown or mismatched session' });
        return;
    }
    try {
        entry.lastSeenAt = Date.now();
        await entry.transport.handleRequest(req, res);
    } catch (err) {
        console.error(`[session:${sessionId.slice(0, 8)}] GET error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── Streamable HTTP: DELETE /mcp (session teardown) ───────────────────────────
app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }
    const entry = sessions.get(sessionId);
    if (!entry || entry.type !== 'streamable') {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    try {
        await entry.transport.close();
    } catch { /* already closed */ }
    removeSession(sessionId);
    res.status(200).json({ status: 'session closed' });
});

// ── Legacy SSE: GET /sse ──────────────────────────────────────────────────────
app.get('/sse', async (req, res) => {
    const { ctx, server } = createSessionPair();
    const forwardedPrefix = typeof req.headers['x-forwarded-prefix'] === 'string'
        ? req.headers['x-forwarded-prefix'].trim()
        : '';
    const normalizedPrefix = forwardedPrefix
        ? (forwardedPrefix.endsWith('/') ? forwardedPrefix.slice(0, -1) : forwardedPrefix)
        : '';
    const messageEndpoint = normalizedPrefix ? `${normalizedPrefix}/messages` : '/messages';
    const transport = new SSEServerTransport(messageEndpoint, res);
    const sid = transport.sessionId;
    ctx._sessionId = sid;

    sessions.set(sid, { type: 'sse', transport, server, ctx, lastSeenAt: Date.now() });
    console.error(`[session:${sid.slice(0, 8)}] opened (sse)`);

    res.on('close', () => {
        try { transport.close(); } catch { /* best effort */ }
        removeSession(sid);
    });

    await server.connect(transport);
});

// ── Legacy SSE: POST /messages ────────────────────────────────────────────────
app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    if (!sessionId) {
        res.status(400).json({ error: 'Missing sessionId query parameter' });
        return;
    }
    const entry = sessions.get(sessionId);
    if (!entry) {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    if (entry.type !== 'sse') {
        res.status(400).json({ error: 'Session is not an SSE session — do not mix transport types' });
        return;
    }
    try {
        entry.lastSeenAt = Date.now();
        await entry.transport.handlePostMessage(req, res, req.body);
    } catch (err) {
        console.error(`[session:${sessionId.slice(0, 8)}] POST /messages error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── Catch-all for unsupported methods on /mcp ─────────────────────────────────
app.all('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'GET, POST, DELETE').json({ error: 'Method not allowed' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(port, host, () => {
    console.error(`Zenith-MCP HTTP Server listening on http://${host}:${port}`);
    console.error(`  Streamable HTTP: POST/GET/DELETE /mcp`);
    console.error(`  Legacy SSE:      GET /sse  +  POST /messages`);
    console.error(`  Health:          GET /health`);
    if (baselineAllowedDirs.length > 0) {
        console.error(`  Baseline dirs:   ${baselineAllowedDirs.join(', ')}`);
    } else {
        console.error(`  No baseline dirs — sessions will rely on MCP roots from clients`);
    }
    ripgrepAvailable().then(ok =>
        console.error(ok ? '  Ripgrep: available' : '  Ripgrep: not found — JS fallback for search')
    );
});
