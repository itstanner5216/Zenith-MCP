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

import { randomUUID } from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, jwtVerify } from 'jose';
// Hybrid: HTTP entrypoint stays on v1 SDK because v2 has no drop-in replacement
//         for the (req, res)-style StreamableHTTPServerTransport / SSEServerTransport.
//         The stdio entrypoint uses v2 (see src/cli/stdio.ts), while the tool
//         implementations remain SDK-agnostic via the ToolServer abstraction in
//         src/tools/types.ts.
import { createRequire } from 'module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
    isInitializeRequest,
    RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createFilesystemContext, type FilesystemContext } from '../core/lib.js';
import {
    registerEnabledTools,
    resolveInitialAllowedDirectories,
    updateAllowedDirectoriesFromRoots,
    validateDirectories,
    SERVER_INSTRUCTIONS,
    setupProjectDetection,
} from '../core/server.js';
import { ripgrepAvailable } from '../core/shared.js';
import { configExists, loadConfig } from '../config/index.js';
import type { ToolServer } from '../tools/types.js';

const _require = createRequire(import.meta.url);
const _pkg = _require('../../package.json') as { version: string };

// ---------------------------------------------------------------------------
// First-run wizard — ensure config exists before proceeding
// ---------------------------------------------------------------------------
if (!configExists()) {
    console.error(
        'FATAL: No Zenith-MCP config found.\n' +
        'Run the stdio server once interactively to complete first-time setup:\n' +
        '  npx zenith-mcp /path/to/your/project\n' +
        '(replace /path/to/your/project with an absolute path to a directory you want the server to access)\n' +
        'Then restart the HTTP server.',
    );
    process.exit(1);
}

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let cliPort: number | undefined;
let host = '0.0.0.0';
const dirArgs: string[] = [];
for (const arg of args) {
    if (arg.startsWith('--port=')) {
        const portStr = arg.slice('--port='.length);
        cliPort = parseInt(portStr, 10);
    } else if (arg.startsWith('--host=')) {
        host = arg.slice('--host='.length);
    } else if (!arg.startsWith('--')) {
        dirArgs.push(arg);
    }
}

// Load config and resolve port: CLI --port flag overrides config value
const config = loadConfig();
const port = cliPort ?? config.port;

// ---------------------------------------------------------------------------
// OAuth configuration — WorkOS/AuthKit authorization server + MCP resource URL
// ---------------------------------------------------------------------------
const AUTHKIT_ISSUER = (process.env.WORKOS_AUTHKIT_ISSUER || process.env.AUTHKIT_ISSUER || '').replace(/\/$/, '');
const PUBLIC_ORIGIN = (process.env.ZENITH_MCP_PUBLIC_ORIGIN || 'https://zenith-mcp.duckdns.org').replace(/\/$/, '');
const OAUTH_MCP_PATH = '/oauth/mcp';
const MCP_RESOURCE = process.env.ZENITH_MCP_RESOURCE || `${PUBLIC_ORIGIN}${OAUTH_MCP_PATH}`;
const RESOURCE_METADATA_PATH = '/.well-known/oauth-protected-resource';
const AUTHORIZATION_SERVER_METADATA_PATH = '/.well-known/oauth-authorization-server';
const RESOURCE_METADATA_URL = `${PUBLIC_ORIGIN}${RESOURCE_METADATA_PATH}`;

const JWKS = AUTHKIT_ISSUER
    ? createRemoteJWKSet(new URL(`${AUTHKIT_ISSUER}/oauth2/jwks`))
    : null;

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
interface StreamableSession {
    type: 'streamable';
    transport: StreamableHTTPServerTransport;
    server: McpServer;
    ctx: FilesystemContext;
    lastSeenAt: number;
}
interface SSESession {
    type: 'sse';
    transport: SSEServerTransport;
    server: McpServer;
    ctx: FilesystemContext;
    lastSeenAt: number;
}
type SessionEntry = StreamableSession | SSESession;
const sessions = new Map<string, SessionEntry>();
// session id -> { type: 'streamable'|'sse', transport, server, ctx }

function writeErrorLog(message: string, err: unknown): void {
    const detail = err instanceof Error && err.stack ? err.stack : String(err);
    process.stderr.write(`${message} ${detail}\n`);
}

function removeSession(sessionId: string): void {
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
const SESSION_TTL_MS = config.advanced.session_ttl_ms;
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
// Helper: spin up a fresh ctx + server for a new session.
//
// This is the v1-specific server construction. It mirrors what cli/stdio.ts
// does for v2, but using v1 SDK APIs:
//   - v1's `new McpServer(info, opts)` constructor
//   - v1's `setNotificationHandler(RootsListChangedNotificationSchema, handler)`
//     which takes a Zod schema rather than a method-name string
//   - the rest of the roots / oninitialized wiring is logically identical to
//     the v2 stdio path; only the SDK calls differ
// ---------------------------------------------------------------------------
function createSessionPair() {
    const ctx = createFilesystemContext([...baselineAllowedDirs]);
    const server = new McpServer(
        { name: 'zenith-mcp', version: _pkg.version },
        { instructions: SERVER_INSTRUCTIONS },
    );
    registerEnabledTools(server as unknown as ToolServer, ctx);

    // Project detection — initial load + notify fn (watcher is process-level)
    setupProjectDetection(ctx, (message) => {
        try {
            server.sendLoggingMessage({
                level: 'info',
                logger: 'zenith-mcp',
                data: message,
            });
        } catch {
            // Transport might not be ready — ignore
        }
    });

    // v1 roots wiring: setNotificationHandler takes a Zod schema as first arg.
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
        try {
            const response = await server.server.listRoots();
            if (response && 'roots' in response) {
                await updateAllowedDirectoriesFromRoots(
                    response.roots.map(r =>
                        r.name !== undefined
                            ? { uri: r.uri, name: r.name }
                            : { uri: r.uri }
                    ),
                    ctx,
                );
            }
        } catch (error) {
            console.error('Failed to request roots from client:', error instanceof Error ? error.message : String(error));
        }
    });

    server.server.oninitialized = async () => {
        const clientCapabilities = server.server.getClientCapabilities();
        if (clientCapabilities?.roots) {
            try {
                const response = await server.server.listRoots();
                if (response && 'roots' in response && response.roots.length > 0) {
                    await updateAllowedDirectoriesFromRoots(
                        response.roots.map(r =>
                            r.name !== undefined
                                ? { uri: r.uri, name: r.name }
                                : { uri: r.uri }
                        ),
                        ctx,
                    );
                } else {
                    console.error('Client returned empty roots, keeping current settings');
                }
            } catch (error) {
                console.error('Failed to request initial roots from client:', error instanceof Error ? error.message : String(error));
            }
        }

        // After all roots attempts: if we still have no dirs, operate in global-only mode.
        // NEVER throw here — an unhandled rejection in oninitialized kills the process.
        const currentDirs = ctx.getAllowedDirectories();
        if (currentDirs.length === 0) {
            console.error(
                'No allowed directories configured. Operating in global-only mode. ' +
                'Tools will use process.cwd() or file paths directly.'
            );
            try {
                await server.sendLoggingMessage({
                    level: 'warning',
                    logger: 'zenith-mcp',
                    data: 'No project directories configured. Operating in global fallback mode. ' +
                          'Provide directories via CLI args or MCP roots for project-scoped features.',
                });
            } catch {
                // sendLoggingMessage may fail if transport isn't ready — ignore
            }
        } else {
            console.error('Client does not support MCP Roots, using allowed directories set from server args:', currentDirs);
        }
    };

    return { ctx, server };
}

// ---------------------------------------------------------------------------
// Helper: sanitize x-forwarded-prefix header value
// ---------------------------------------------------------------------------
function sanitizeForwardedPrefix(raw: string | string[] | undefined): string {
    if (!raw) return '';
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) return '';
    const trimmed = value.trim();

    // Reject invalid prefixes: must start with single '/', no schemes/hosts
    if (!trimmed.startsWith('/')) return '';
    if (trimmed.startsWith('//')) return '';
    if (trimmed.includes('://') || /^\/[^/]*:/.test(trimmed)) return '';

    // Normalize: single leading slash, no trailing slash
    return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed;
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: '4mb' }));

function oauthChallenge(): string {
    return [
        'Bearer error="unauthorized"',
        'error_description="Authorization needed"',
        `resource_metadata="${RESOURCE_METADATA_URL}"`,
    ].join(', ');
}

function unauthorized(res: Response, message = 'Unauthorized'): void {
    res
        .set('WWW-Authenticate', oauthChallenge())
        .status(401)
        .json({ error: message });
}

async function requireOAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const match = req.headers.authorization?.match(/^Bearer\s+(\S.*)$/i);
    const token = match?.[1];
    if (!token) {
        unauthorized(res, 'No bearer token provided.');
        return;
    }

    if (!AUTHKIT_ISSUER || !JWKS) {
        res.status(503).json({ error: 'OAuth is not configured. Set WORKOS_AUTHKIT_ISSUER.' });
        return;
    }

    try {
        await jwtVerify(token, JWKS, {
            issuer: AUTHKIT_ISSUER,
            audience: MCP_RESOURCE,
        });
        next();
    } catch (error) {
        console.error('OAuth token verification failed:', error instanceof Error ? error.message : String(error));
        unauthorized(res, 'Invalid bearer token.');
    }
}

app.get('/', (_req, res) => {
    res.json({
        name: 'zenith-mcp',
        status: 'ok',
        mcp: `${PUBLIC_ORIGIN}/mcp`,
        resource: MCP_RESOURCE,
        oauthConfigured: Boolean(AUTHKIT_ISSUER),
        authorizationServer: AUTHKIT_ISSUER || null,
        resourceMetadata: RESOURCE_METADATA_URL,
    });
});

app.get(RESOURCE_METADATA_PATH, (_req, res) => {
    if (!AUTHKIT_ISSUER) {
        res.status(503).json({ error: 'OAuth is not configured. Set WORKOS_AUTHKIT_ISSUER.' });
        return;
    }

    res.json({
        resource: MCP_RESOURCE,
        authorization_servers: [AUTHKIT_ISSUER],
        bearer_methods_supported: ['header'],
        scopes_supported: ['openid', 'profile', 'email'],
    });
});

app.get(AUTHORIZATION_SERVER_METADATA_PATH, async (_req, res) => {
    if (!AUTHKIT_ISSUER) {
        res.status(503).json({ error: 'OAuth is not configured. Set WORKOS_AUTHKIT_ISSUER.' });
        return;
    }

    try {
        const response = await fetch(`${AUTHKIT_ISSUER}${AUTHORIZATION_SERVER_METADATA_PATH}`, {
            signal: AbortSignal.timeout(5000),
        });
        const body = await response.text();
        res
            .status(response.status)
            .type(response.headers.get('content-type') || 'application/json')
            .send(body);
    } catch (error) {
        writeErrorLog('Failed to proxy OAuth authorization server metadata:', error);
        res.status(502).json({ error: 'Failed to fetch authorization server metadata' });
    }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
    res.json({
        status: 'ok',
        auth: AUTHKIT_ISSUER ? 'workos-authkit-oauth-additive' : 'oauth-not-configured',
        issuer: AUTHKIT_ISSUER || null,
        resource: MCP_RESOURCE,
        sessions: sessions.size,
        baselineDirs: baselineAllowedDirs.length,
        sessionTtlSeconds: SESSION_TTL_MS / 1000,
    });
});

// OAuth is additive, not global. Existing /mcp, /sse, and /messages routes stay
// available for local/non-OAuth clients. Claude/WorkOS OAuth clients use /oauth/mcp.

// ── OAuth Streamable HTTP: POST /oauth/mcp ────────────────────────────────────
app.post(OAUTH_MCP_PATH, requireOAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // ── Existing session: forward the message ──
    if (sessionId) {
        const entry = sessions.get(sessionId as string);
        if (!entry || entry.type !== 'streamable') {
            res.status(400).json({ error: 'Unknown or mismatched session' });
            return;
        }
        try {
            entry.lastSeenAt = Date.now();
            await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
            writeErrorLog(`[session:${(sessionId as string).slice(0, 8)}] OAuth POST error:`, err);
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
    const sid = randomUUID();
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sid,
    });

    transport.onclose = () => {
        removeSession(sid);
    };

    await server.connect(transport);

    sessions.set(sid, {
        type: 'streamable',
        transport,
        server,
        ctx,
        lastSeenAt: Date.now(),
    });
    console.error(`[session:${sid.slice(0, 8)}] opened (oauth streamable)`);

    try {
        await transport.handleRequest(req, res, req.body);
        if (transport.sessionId !== sid) {
            removeSession(sid);
            try { await transport.close(); } catch { /* already dead */ }
        }
    } catch (err) {
        removeSession(sid);
        try { await transport.close(); } catch { /* best effort — already closed */ }
        writeErrorLog(`[session:${sid.slice(0, 8)}] OAuth initialize error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── OAuth Streamable HTTP: GET /oauth/mcp ─────────────────────────────────────
app.get(OAUTH_MCP_PATH, requireOAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }
    const entry = sessions.get(sessionId as string);
    if (!entry || entry.type !== 'streamable') {
        res.status(400).json({ error: 'Unknown or mismatched session' });
        return;
    }
    try {
        entry.lastSeenAt = Date.now();
        await entry.transport.handleRequest(req, res);
    } catch (err) {
        const safeId = String(sessionId).replace(/[^\w-]/g, '').slice(0, 8);
        writeErrorLog(`[session:${safeId}] OAuth GET error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── OAuth Streamable HTTP: DELETE /oauth/mcp ──────────────────────────────────
app.delete(OAUTH_MCP_PATH, requireOAuth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }
    const entry = sessions.get(sessionId as string);
    if (!entry || entry.type !== 'streamable') {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    try {
        await entry.transport.close();
    } catch { /* already closed */ }
    removeSession(sessionId as string);
    res.status(200).json({ status: 'session closed' });
});

app.all(OAUTH_MCP_PATH, (_req, res) => {
    res.status(405).set('Allow', 'GET, POST, DELETE').json({ error: 'Method not allowed' });
});

// ── Streamable HTTP: POST /mcp ────────────────────────────────────────────────
app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];

    // ── Existing session: forward the message ──
    if (sessionId) {
        const entry = sessions.get(sessionId as string);
        if (!entry || entry.type !== 'streamable') {
            res.status(400).json({ error: 'Unknown or mismatched session' });
            return;
        }
        try {
            entry.lastSeenAt = Date.now();
            await entry.transport.handleRequest(req, res, req.body);
        } catch (err) {
            writeErrorLog(`[session:${(sessionId as string).slice(0, 8)}] POST error:`, err);
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

    const sid = randomUUID();

    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sid,
    });

    // Session cleanup when the transport closes.
    // SDK's connect() chains any pre-existing onclose handler, so this fires
    // alongside the SDK's internal cleanup (_onclose) on disconnect.
    transport.onclose = () => {
        removeSession(sid);
    };

    await server.connect(transport);

    // Pre-register so the session is discoverable if a concurrent request arrives
    // after the initialize response is sent but before this handler returns.
    sessions.set(sid, {
        type: 'streamable',
        transport,
        server,
        ctx,
        lastSeenAt: Date.now(),
    });
    console.error(`[session:${sid.slice(0, 8)}] opened (streamable)`);

    try {
        await transport.handleRequest(req, res, req.body);

        // If the SDK rejected initialization (e.g. bad headers, protocol error)
        // it returns an error response without throwing. In that case the transport
        // never adopts the session ID and the client never receives it — clean up.
        if (transport.sessionId !== sid) {
            removeSession(sid);
            try { await transport.close(); } catch { /* already dead */ }
        }
    } catch (err) {
        removeSession(sid);
        try { await transport.close(); } catch { /* best effort — already closed */ }
        writeErrorLog(`[session:${sid.slice(0, 8)}] initialize error:`, err);
        if (!res.headersSent) res.status(500).json({ error: 'Internal error' });
    }
});

// ── Streamable HTTP: GET /mcp (SSE notification stream) ───────────────────────
app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (!sessionId) {
        res.status(400).json({ error: 'Missing Mcp-Session-Id header' });
        return;
    }
    const entry = sessions.get(sessionId as string);
    if (!entry || entry.type !== 'streamable') {
        res.status(400).json({ error: 'Unknown or mismatched session' });
        return;
    }
    try {
        entry.lastSeenAt = Date.now();
        await entry.transport.handleRequest(req, res);
    } catch (err) {
        const safeId = String(sessionId).replace(/[^\w-]/g, '').slice(0, 8);
        writeErrorLog(`[session:${safeId}] GET error:`, err);
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
    const entry = sessions.get(sessionId as string);
    if (!entry || entry.type !== 'streamable') {
        res.status(404).json({ error: 'Session not found' });
        return;
    }
    try {
        await entry.transport.close();
    } catch { /* already closed */ }
    removeSession(sessionId as string);
    res.status(200).json({ status: 'session closed' });
});

// ── Legacy SSE: GET /sse ──────────────────────────────────────────────────────
app.get('/sse', async (req, res) => {
    const { ctx, server } = createSessionPair();
    const prefix = sanitizeForwardedPrefix(req.headers['x-forwarded-prefix']);
    const messageEndpoint = prefix ? `${prefix}/messages` : '/messages';
    const transport = new SSEServerTransport(messageEndpoint, res);
    const sid = transport.sessionId;


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
    const sessionId = req.query['sessionId'];
    if (!sessionId || typeof sessionId !== 'string') {
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
        const safeId = sessionId.replace(/[^\w-]/g, '').slice(0, 8);
        writeErrorLog(`[session:${safeId}] POST /messages error:`, err);
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
    console.error(`  OAuth HTTP:      POST/GET/DELETE ${OAUTH_MCP_PATH}`);
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
