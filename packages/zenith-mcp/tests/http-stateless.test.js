import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_SERVER = path.resolve(__dirname, '../dist/server/http.js');
const API_KEY = 'test-api-key-http-stateless';

const INIT_REQUEST = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'vitest-http-stateless', version: '1.0.0' },
    },
};

const TOOLS_LIST_REQUEST = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
};

function getFreePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (address && typeof address === 'object') {
                    resolve(address.port);
                } else {
                    reject(new Error('Failed to allocate a test port'));
                }
            });
        });
    });
}

function writeMinimalConfig(homeDir, port) {
    const configDir = path.join(homeDir, '.zenith-mcp');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'config'),
        [
            `Port: ${port}`,
            '',
        ].join('\n'),
        'utf8',
    );
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

// The SDK may answer a JSON-RPC POST as plain JSON or as a single-event SSE
// body depending on negotiation; accept both shapes.
async function parseRpcResponse(response) {
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    if (contentType.includes('text/event-stream')) {
        const dataLines = text
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice('data:'.length).trim())
            .filter((line) => line.length > 0);
        expect(dataLines.length).toBeGreaterThan(0);
        return JSON.parse(dataLines[dataLines.length - 1]);
    }
    return JSON.parse(text);
}

describe('HTTP stateless MCP endpoint (2026-07-28, legacy stateless fallback)', () => {
    let child;
    let homeDir;
    let baseUrl;
    let stderr;

    beforeEach(async () => {
        const port = await getFreePort();
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-http-stateless-test-'));
        writeMinimalConfig(homeDir, port);
        baseUrl = `http://127.0.0.1:${port}`;
        stderr = '';

        child = spawn(process.execPath, [HTTP_SERVER, '--host=127.0.0.1', `--port=${port}`], {
            env: {
                ...process.env,
                HOME: homeDir,
                ZENITH_API_KEY: '',
                ZENITH_MCP_API_KEY: API_KEY,
            },
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            stderr += chunk;
        });

        await waitForHealth();
    }, 10000);

    afterEach(async () => {
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
            await new Promise((resolve) => child.once('exit', resolve));
        }
        if (homeDir) {
            fs.rmSync(homeDir, { recursive: true, force: true });
        }
    });

    async function waitForHealth() {
        const deadline = Date.now() + 5000;
        let lastError;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`HTTP server exited before health check passed: ${stderr}`);
            }
            try {
                const response = await fetchWithTimeout(`${baseUrl}/health`, {}, 500);
                if (response.ok) return;
                lastError = new Error(`health returned ${response.status}`);
            } catch (err) {
                lastError = err;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for HTTP server health: ${lastError?.message ?? 'unknown'}\n${stderr}`);
    }

    function mcpPost(body, headers = {}) {
        return fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
                ...headers,
            },
            body: JSON.stringify(body),
        });
    }

    it('returns 401 when /mcp is called without a bearer token', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'Invalid or missing API key.' });
    });

    it('returns 401 when /mcp is called with an invalid bearer token', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: 'Bearer invalid-token',
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        expect(response.status).toBe(401);
    });

    it('answers a 2025-era initialize without issuing a session id', async () => {
        const response = await mcpPost(INIT_REQUEST);

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toBeNull();

        const rpc = await parseRpcResponse(response);
        expect(rpc.id).toBe(1);
        expect(rpc.result).toBeDefined();
        expect(rpc.result.serverInfo?.name).toBe('zenith-mcp');
    });

    it('serves a bare tools/list with no prior handshake and no session header', async () => {
        const response = await mcpPost(TOOLS_LIST_REQUEST);

        expect(response.status).toBe(200);
        expect(response.headers.get('mcp-session-id')).toBeNull();

        const rpc = await parseRpcResponse(response);
        expect(rpc.id).toBe(2);
        expect(rpc.result).toBeDefined();
        expect(Array.isArray(rpc.result.tools)).toBe(true);
        expect(rpc.result.tools.length).toBeGreaterThan(0);
    });

    it('answers GET /mcp with 405 (2025 session operations are not served)', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'GET',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                Accept: 'text/event-stream',
            },
        });
        expect(response.status).toBe(405);
    });

    it('answers DELETE /mcp with 405 (no sessions to tear down)', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'mcp-session-id': 'no-such-session',
            },
        });
        expect(response.status).toBe(405);
    });

    it('reports a session-free health payload', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/health`);
        expect(response.status).toBe(200);
        const health = await response.json();
        expect(health.status).toBe('ok');
        expect(health.auth).toEqual({ mcp: 'api-key' });
        expect(typeof health.baselineDirs).toBe('number');
        expect(health).not.toHaveProperty('sessions');
        expect(health).not.toHaveProperty('sessionTtlSeconds');
    });
});
