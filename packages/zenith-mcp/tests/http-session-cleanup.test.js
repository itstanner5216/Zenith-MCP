import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HTTP_SERVER = path.resolve(__dirname, '../dist/server/http.js');
const API_KEY = 'test-api-key-http-session-cleanup';

const INIT_REQUEST = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'vitest-http-session-cleanup', version: '1.0.0' },
    },
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
            '### Advanced',
            'session_ttl_ms: 30000',
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

describe('HTTP streamable initialize session cleanup', () => {
    let child;
    let homeDir;
    let baseUrl;
    let stderr;

    beforeEach(async () => {
        const port = await getFreePort();
        homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenith-http-session-test-'));
        writeMinimalConfig(homeDir, port);
        baseUrl = `http://127.0.0.1:${port}`;
        stderr = '';

        child = spawn(process.execPath, [HTTP_SERVER, '--host=127.0.0.1', `--port=${port}`], {
            env: {
                ...process.env,
                HOME: homeDir,
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
                const response = await fetchWithTimeout(`${baseUrl}/health`, {
                    headers: { Authorization: `Bearer ${API_KEY}` },
                }, 500);
                if (response.ok) return;
                lastError = new Error(`health returned ${response.status}`);
            } catch (err) {
                lastError = err;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Timed out waiting for HTTP server health: ${lastError?.message ?? 'unknown'}\n${stderr}`);
    }

    async function getHealth() {
        const response = await fetchWithTimeout(`${baseUrl}/health`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
        });
        expect(response.status).toBe(200);
        return await response.json();
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
                Authorization: ['Bearer', 'invalid-token'].join(' '),
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({ error: 'Invalid or missing API key.' });
    });

    it('allows a valid bearer token to reach /mcp', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: ['Bearer', API_KEY].join(' '),
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        // 406 comes from downstream MCP transport validation (missing Accept), proving auth passed.
        expect(response.status).toBe(406);
    });

    it('removes the pre-registered session when initialize is rejected by non-throwing transport validation', async () => {
        // Inferred from http.ts: isInitializeRequest only validates the JSON-RPC body.
        // The SDK can still reject the request later for HTTP-level errors such as
        // an Accept header that does not list both application/json and text/event-stream.
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        expect(response.status).toBe(406);
        expect(response.headers.get('mcp-session-id')).toBeNull();

        const health = await getHealth();
        expect(health.sessions).toBe(0);
    }, 10000);

    it('keeps a successfully initialized session and removes it on explicit teardown', async () => {
        const response = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                Accept: 'application/json, text/event-stream',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(INIT_REQUEST),
        });

        expect(response.status).toBe(200);
        const sessionId = response.headers.get('mcp-session-id');
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);
        const body = await response.text();
        expect(body).toContain('"id":1');

        const initializedHealth = await getHealth();
        expect(initializedHealth.sessions).toBe(1);

        const deleteResponse = await fetchWithTimeout(`${baseUrl}/mcp`, {
            method: 'DELETE',
            headers: {
                Authorization: `Bearer ${API_KEY}`,
                'Mcp-Session-Id': sessionId,
            },
        });
        expect(deleteResponse.status).toBe(200);

        const closedHealth = await getHealth();
        expect(closedHealth.sessions).toBe(0);
    }, 10000);
});
