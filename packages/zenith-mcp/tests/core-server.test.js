import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';

const TOOL_REGISTERS = [
    '../dist/tools/read_file.js',
    '../dist/tools/search_file.js',
    '../dist/tools/read_media_file.js',
    '../dist/tools/read_multiple_files.js',
    '../dist/tools/write_file.js',
    '../dist/tools/edit_file.js',
    '../dist/tools/directory.js',
    '../dist/tools/search_files.js',
    '../dist/tools/filesystem.js',
    '../dist/tools/stash_restore.js',
    '../dist/tools/refactor_batch.js',
];

const CONFIG_INDEX = '../dist/config/index.js';
const ADAPTERS_INDEX = '../dist/adapters/index.js';
const RETRIEVAL_INDEX = '../dist/retrieval/index.js';
const PROJECT_CONTEXT = '../dist/core/project-context.js';
const ROOTS_UTILS = '../dist/core/roots-utils.js';
const SERVER_MOD = '../dist/core/server.js';

function makeMockCtx(overrides = {}) {
    return {
        getAllowedDirectories: vi.fn(() => overrides.allowedDirs ?? ['/tmp']),
        setAllowedDirectories: vi.fn(),
        validatePath: vi.fn(async (p) => p),
        _retrievalPipeline: null,
        _toolRegistry: null,
        ...overrides,
    };
}

function makeMockServer() {
    return {
        server: {
            setNotificationHandler: vi.fn(),
            listRoots: vi.fn(),
            getClientCapabilities: vi.fn(),
            oninitialized: null,
        },
    };
}

function mockAllDeps(customMocks = {}) {
    for (const modPath of TOOL_REGISTERS) {
        vi.doMock(modPath, () => ({ register: vi.fn() }));
    }
    vi.doMock(CONFIG_INDEX, () => ({
        loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
        syncToolsWithConfig: vi.fn((config, toolNames) => ({
            config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
            changed: false,
        })),
        patchToolsInConfig: vi.fn(),
    }));
    vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry: vi.fn() }));
    vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn() }));
    for (const [modPath, factory] of Object.entries(customMocks)) {
        vi.doMock(modPath, factory);
    }
}

async function importServer(customMocks = {}) {
    vi.resetModules();
    mockAllDeps(customMocks);
    return await import(SERVER_MOD);
}

async function getToolMocks(customMocks = {}) {
    vi.resetModules();
    const mocks = {};
    for (const modPath of TOOL_REGISTERS) {
        const fn = vi.fn();
        mocks[modPath] = fn;
        vi.doMock(modPath, () => ({ register: fn }));
    }
    vi.doMock(CONFIG_INDEX, () => ({
        loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
        syncToolsWithConfig: vi.fn((config, toolNames) => ({
            config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
            changed: false,
        })),
        patchToolsInConfig: vi.fn(),
    }));
    vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry: vi.fn() }));
    vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn() }));
    for (const [modPath, factory] of Object.entries(customMocks)) {
        vi.doMock(modPath, factory);
    }
    const mod = await import(SERVER_MOD);
    return { mod, mocks };
}

describe('createFilesystemServer', () => {
    it('returns an object with a server property', async () => {
        const { mod } = await getToolMocks();
        const ctx = makeMockCtx();
        const result = mod.createFilesystemServer(ctx);
        expect(result).toBeDefined();
        expect(result.server).toBeDefined();
    });

    it('registers all 11 tools', async () => {
        const { mod, mocks } = await getToolMocks();
        const ctx = makeMockCtx();
        mod.createFilesystemServer(ctx);
        for (const modPath of TOOL_REGISTERS) {
            expect(mocks[modPath]).toHaveBeenCalledTimes(1);
        }
    });

    it('passes server and ctx to each register call', async () => {
        const { mod, mocks } = await getToolMocks();
        const ctx = makeMockCtx();
        const result = mod.createFilesystemServer(ctx);
        for (const modPath of TOOL_REGISTERS) {
            expect(mocks[modPath]).toHaveBeenCalledWith(result, ctx);
        }
    });

    it('calls configureRegistry when adapters are enabled', async () => {
        vi.resetModules();
        const configureRegistry = vi.fn();
        for (const modPath of TOOL_REGISTERS) {
            vi.doMock(modPath, () => ({ register: vi.fn() }));
        }
        vi.doMock(CONFIG_INDEX, () => ({
            loadConfig: vi.fn(() => ({
                enabledAdapters: ['claude-desktop'],
                backupDir: '/backup',
                tools: {},
                auto_write: { status: true, backup_dir: '/backup' },
            })),
            syncToolsWithConfig: vi.fn((config, toolNames) => ({
                config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
                changed: false,
            })),
            patchToolsInConfig: vi.fn(),
            expandTilde: vi.fn((p) => p),
        }));
        vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry }));
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn() }));
        const mod = await import(SERVER_MOD);
        mod.createFilesystemServer(makeMockCtx());
        expect(configureRegistry).toHaveBeenCalledWith('/backup');
    });

    it('does not call configureRegistry when no adapters are enabled', async () => {
        vi.resetModules();
        const configureRegistry = vi.fn();
        for (const modPath of TOOL_REGISTERS) {
            vi.doMock(modPath, () => ({ register: vi.fn() }));
        }
        vi.doMock(CONFIG_INDEX, () => ({
            loadConfig: vi.fn(() => ({ enabledAdapters: [], backupDir: undefined, tools: {}, auto_write: { status: false } })),
            syncToolsWithConfig: vi.fn((config, toolNames) => ({
                config: { ...config, tools: Object.fromEntries(toolNames.map(n => [n, true])) },
                changed: false,
            })),
            patchToolsInConfig: vi.fn(),
        }));
        vi.doMock(ADAPTERS_INDEX, () => ({ configureRegistry }));
        vi.doMock(PROJECT_CONTEXT, () => ({ onRootsChanged: vi.fn() }));
        const mod = await import(SERVER_MOD);
        mod.createFilesystemServer(makeMockCtx());
        expect(configureRegistry).not.toHaveBeenCalled();
    });
});

describe('resolveInitialAllowedDirectories', () => {
    it('resolves a regular path', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/tmp']);
        expect(result).toHaveLength(1);
        expect(result[0]).toBe('/tmp');
    });

    it('resolves multiple paths', async () => {
        const mod = await importServer();
        const dirs = ['/tmp', '/var'];
        const result = await mod.resolveInitialAllowedDirectories(dirs);
        expect(result).toHaveLength(2);
    });

    it('handles empty input', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories([]);
        expect(result).toEqual([]);
    });

    it('expands home directory', async () => {
        const mod = await importServer();
        const home = os.homedir();
        const result = await mod.resolveInitialAllowedDirectories(['~']);
        expect(result[0]).toBe(home);
    });

    it('expands home subdirectory', async () => {
        const mod = await importServer();
        const home = os.homedir();
        const result = await mod.resolveInitialAllowedDirectories(['~/Documents']);
        expect(result[0]).toBe(path.join(home, 'Documents'));
    });

    it('normalizes paths (resolves ..)', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/tmp/..']);
        expect(result[0]).toBe('/');
    });

    it('falls back to absolute path when realpath fails', async () => {
        const mod = await importServer();
        const result = await mod.resolveInitialAllowedDirectories(['/nonexistent_dir_xyz']);
        expect(result[0]).toBe('/nonexistent_dir_xyz');
    });
});

describe('validateDirectories', () => {
    let tmpDir;

    afterEach(() => {
        try {
            const fs = require('fs');
            if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('passes for valid directories', async () => {
        const mod = await importServer();
        const fs = await import('fs');
        tmpDir = path.join(os.tmpdir(), `validate-dir-test-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        await expect(mod.validateDirectories([tmpDir])).resolves.toBeUndefined();
    });

    it('throws when directory does not exist', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories(['/nonexistent_dir_xyz_123']))
            .rejects.toThrow('Directory validation failed');
    });

    it('throws when path is a file not a directory', async () => {
        const mod = await importServer();
        const fs = await import('fs');
        const filePath = path.join(os.tmpdir(), `validate-file-test-${Date.now()}`);
        fs.writeFileSync(filePath, 'test');
        try {
            await expect(mod.validateDirectories([filePath]))
                .rejects.toThrow('is not a directory');
        } finally {
            fs.unlinkSync(filePath);
        }
    });

    it('throws with all errors when multiple directories are invalid', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories(['/nonexistent_1_xyz', '/nonexistent_2_xyz']))
            .rejects.toThrow('nonexistent_1');
    });

    it('passes when given an empty array', async () => {
        const mod = await importServer();
        await expect(mod.validateDirectories([])).resolves.toBeUndefined();
    });
});

describe('attachRootsHandlers', () => {
    let mod;
    let mockServer;
    let ctx;
    let onRootsChanged;
    let getValidRootDirectories;

    async function setup(customCtx) {
        onRootsChanged = vi.fn();
        getValidRootDirectories = vi.fn(async (roots) =>
            roots.map(r => r.uri.replace('file://', ''))
        );
        const result = await getToolMocks({
            [PROJECT_CONTEXT]: () => ({ onRootsChanged }),
            [ROOTS_UTILS]: () => ({ getValidRootDirectories }),
        });
        mod = result.mod;
        mockServer = makeMockServer();
        ctx = customCtx ?? makeMockCtx();
    }

    it('registers a notification handler for RootsListChangedNotificationSchema', async () => {
        await setup();
        mod.attachRootsHandlers(mockServer, ctx);
        expect(mockServer.server.setNotificationHandler).toHaveBeenCalledTimes(1);
    });

    it('assigns oninitialized callback', async () => {
        await setup();
        mod.attachRootsHandlers(mockServer, ctx);
        expect(mockServer.server.oninitialized).toBeDefined();
        expect(typeof mockServer.server.oninitialized).toBe('function');
    });

    describe('oninitialized — client supports roots', () => {
        beforeEach(async () => {
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.getClientCapabilities.mockReturnValue({ roots: { listChanged: true } });
            mockServer.server.listRoots.mockResolvedValue({
                roots: [{ uri: 'file:///project/a' }, { uri: 'file:///project/b' }],
            });
        });

        it('calls listRoots on client', async () => {
            await mockServer.server.oninitialized();
            expect(mockServer.server.listRoots).toHaveBeenCalled();
        });

        it('updates allowed directories from roots', async () => {
            await mockServer.server.oninitialized();
            expect(ctx.setAllowedDirectories).toHaveBeenCalledWith(['/project/a', '/project/b']);
        });

        it('calls onRootsChanged with context', async () => {
            await mockServer.server.oninitialized();
            expect(onRootsChanged).toHaveBeenCalled();
        });
    });

    describe('oninitialized — client returns empty roots', () => {
        beforeEach(async () => {
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.getClientCapabilities.mockReturnValue({ roots: { listChanged: true } });
            mockServer.server.listRoots.mockResolvedValue({ roots: [] });
        });

        it('does not throw when roots are empty', async () => {
            await expect(mockServer.server.oninitialized()).resolves.toBeUndefined();
        });

        it('does not call setAllowedDirectories with empty roots', async () => {
            await mockServer.server.oninitialized();
            expect(ctx.setAllowedDirectories).not.toHaveBeenCalled();
        });
    });

    describe('oninitialized — client does not support roots', () => {
        beforeEach(async () => {
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.getClientCapabilities.mockReturnValue(null);
        });

        it('does not throw when existing allowed directories exist', async () => {
            await expect(mockServer.server.oninitialized()).resolves.toBeUndefined();
        });

        it('throws when no allowed directories are available', async () => {
            const ctxEmpty = makeMockCtx({ allowedDirs: [] });
            onRootsChanged = vi.fn();
            getValidRootDirectories = vi.fn(async (roots) =>
                roots.map(r => r.uri.replace('file://', ''))
            );
            const result = await getToolMocks({
                [PROJECT_CONTEXT]: () => ({ onRootsChanged }),
                [ROOTS_UTILS]: () => ({ getValidRootDirectories }),
            });
            const ms = makeMockServer();
            result.mod.attachRootsHandlers(ms, ctxEmpty);
            ms.server.getClientCapabilities.mockReturnValue(null);
            await expect(ms.server.oninitialized())
                .rejects.toThrow('Server cannot operate');
        });
    });

    describe('oninitialized — listRoots response has no roots key', () => {
        beforeEach(async () => {
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.getClientCapabilities.mockReturnValue({ roots: {} });
            mockServer.server.listRoots.mockResolvedValue({});
        });

        it('does not throw when response lacks roots property', async () => {
            await expect(mockServer.server.oninitialized()).resolves.toBeUndefined();
        });
    });

    describe('RootsListChanged notification handler', () => {
        beforeEach(async () => {
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.listRoots.mockResolvedValue({
                roots: [{ uri: 'file:///new/root' }],
            });
        });

        it('handles root change notification and updates directories', async () => {
            const handler = mockServer.server.setNotificationHandler.mock.calls[0][1];
            await handler();
            expect(ctx.setAllowedDirectories).toHaveBeenCalledWith(['/new/root']);
        });

        it('catches errors when listRoots fails', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            mockServer.server.listRoots.mockRejectedValue(new Error('connection lost'));
            const handler = mockServer.server.setNotificationHandler.mock.calls[0][1];
            await handler();
            expect(consoleSpy).toHaveBeenCalledWith('Failed to request roots from client:', 'connection lost');
            consoleSpy.mockRestore();
        });
    });

    describe('oninitialized error handling', () => {
        it('catches errors when listRoots fails during init', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            await setup();
            mod.attachRootsHandlers(mockServer, ctx);
            mockServer.server.getClientCapabilities.mockReturnValue({ roots: {} });
            mockServer.server.listRoots.mockRejectedValue(new Error('timeout'));
            await expect(mockServer.server.oninitialized()).resolves.toBeUndefined();
            expect(consoleSpy).toHaveBeenCalledWith('Failed to request initial roots from client:', 'timeout');
            consoleSpy.mockRestore();
        });
    });

    describe('updateAllowedDirectoriesFromRoots', () => {
        it('logs when no valid root directories are provided', async () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
            getValidRootDirectories = vi.fn(async () => []);
            const result = await getToolMocks({
                [PROJECT_CONTEXT]: () => ({ onRootsChanged: vi.fn() }),
                [ROOTS_UTILS]: () => ({ getValidRootDirectories }),
            });
            const m = result.mod;
            const ms = makeMockServer();
            const c = makeMockCtx();
            m.attachRootsHandlers(ms, c);
            ms.server.getClientCapabilities.mockReturnValue({ roots: {} });
            ms.server.listRoots.mockResolvedValue({ roots: [{ uri: 'file:///invalid' }] });
            await ms.server.oninitialized();
            expect(consoleSpy).toHaveBeenCalledWith('No valid root directories provided by client');
            consoleSpy.mockRestore();
        });
    });
});
