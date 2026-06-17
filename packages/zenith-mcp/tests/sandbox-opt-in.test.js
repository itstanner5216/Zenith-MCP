// ---------------------------------------------------------------------------
// sandbox-opt-in.test.js
//
// Regression guard for commit 7312e0d: sandbox enforcement is OPT-IN.
//
// Before 7312e0d, allowed-directory presence silently turned enforcement on.
// After 7312e0d, `_sandboxEnabled` defaults to FALSE regardless of whether
// directories are configured. The config flag (`sandbox: boolean`, default
// false) must be the SOLE gate — wired by registerEnabledTools via
// ctx.setSandboxEnabled(syncedConfig.sandbox).
//
// This file fails LOUDLY if any of the following regressions land:
//
//   (A) Behavioral regression — the `if (!_sandboxEnabled) return true;`
//       short-circuit is removed from isInsideAllowed, re-coupling enforcement
//       to allowlist presence. The primary guard: createFilesystemContext with
//       a non-empty allowlist but default sandbox state must accept paths
//       outside the allowlist.
//
//   (B) Wiring regression — the setSandboxEnabled call or the `.sandbox`
//       config field reference is removed from server.ts, orphaning the config
//       flag so that even `Sandbox: enabled` in the config has no effect.
//       Detected via source-scan (does not require a build).
//
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import nodeFsPromises from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function importLib() {
    return await import('../dist/core/lib.js');
}

// ---------------------------------------------------------------------------
// A. BEHAVIORAL — the core sandbox/allowlist decoupling
// ---------------------------------------------------------------------------

describe('sandbox-opt-in — A. behavioral: sandbox OFF by default (the primary guard)', () => {
    let tmpDir;
    let realTmpDir;

    beforeEach(() => {
        vi.resetModules();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbox-optin-'));
        // os.tmpdir() may be a symlink (e.g. /var -> /private/var on macOS).
        // isInsideAllowed compares realpath-resolved paths, so pin the realpath.
        realTmpDir = fs.realpathSync(tmpDir);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it(
        'PRIMARY GUARD — validatePath with default sandbox state resolves a path OUTSIDE the allowlist',
        async () => {
            // This is the assertion that fails when someone re-couples enforcement to
            // allowlist presence. If `if (!_sandboxEnabled) return true;` is removed from
            // isInsideAllowed, this call will throw "Access denied" and the test will fail.
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]); // allowlist is set, sandbox is NOT enabled
            // /etc/hostname exists on Linux; use a path we know resolves.
            // If it doesn't exist on this host the ENOENT branch also goes through
            // isInsideAllowed (parent=/etc which is outside) — still should NOT throw.
            await expect(
                fsc.validatePath('/etc/hostname'),
                'REGRESSION: validatePath threw on an outside path even though sandbox was never enabled. ' +
                'Someone re-coupled enforcement to allowed-directory PRESENCE. ' +
                'The fix: isInsideAllowed must return true immediately when _sandboxEnabled is false, ' +
                'regardless of the allowlist contents.',
            ).resolves.toBeTruthy();
        },
    );

    it(
        'validateNewFilePath with default sandbox state resolves a new path OUTSIDE the allowlist',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]); // sandbox NOT enabled
            await expect(
                fsc.validateNewFilePath('/etc/some-new-zenith-regression-guard.conf'),
                'REGRESSION: validateNewFilePath threw on an outside path with sandbox disabled. ' +
                'Enforcement must only activate when setSandboxEnabled(true) has been called explicitly.',
            ).resolves.toBeTruthy();
        },
    );

    it(
        'validates a path INSIDE the allowlist when sandbox is OFF (basic sanity)',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);
            // Sandbox is off — inside paths should still work.
            const result = await fsc.validatePath(tmpDir);
            expect(
                result,
                'validatePath on the allowed dir itself should return the resolved path.',
            ).toBe(realTmpDir);
        },
    );

    it(
        'after setSandboxEnabled(true) — outside path throws Access denied',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);
            fsc.setSandboxEnabled(true);
            await expect(
                fsc.validatePath('/etc/hostname'),
                'REGRESSION: validatePath did NOT throw when sandbox was enabled and the path is outside ' +
                'the allowlist. setSandboxEnabled(true) must activate boundary enforcement.',
            ).rejects.toThrow('Access denied');
        },
    );

    it(
        'after setSandboxEnabled(true) — inside path still resolves',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);
            fsc.setSandboxEnabled(true);
            const result = await fsc.validatePath(tmpDir);
            expect(
                result,
                'A path inside the allowed dir must resolve even with sandbox ON.',
            ).toBe(realTmpDir);
        },
    );

    it(
        'sandbox ON with EMPTY allowlist stays permissive (nothing to gate against)',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([]); // empty allowlist
            fsc.setSandboxEnabled(true);
            await expect(
                fsc.validatePath('/etc/hostname'),
                'With sandbox ON but NO configured dirs, isInsideAllowed must return true ' +
                '(nothing to gate against). An empty allowlist must not block everything.',
            ).resolves.toBeTruthy();
        },
    );

    it(
        'toggle test — enable blocks outside path, then disable makes it resolve again',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);

            // Round 1: sandbox ON → outside path is blocked
            fsc.setSandboxEnabled(true);
            await expect(
                fsc.validatePath('/etc/hostname'),
                'Round 1 (sandbox ON): outside path must throw Access denied.',
            ).rejects.toThrow('Access denied');

            // Round 2: sandbox OFF → same path now resolves
            fsc.setSandboxEnabled(false);
            await expect(
                fsc.validatePath('/etc/hostname'),
                'REGRESSION: After setSandboxEnabled(false), the outside path still threw. ' +
                'The sandbox flag must be a live gate — disabling it must immediately restore ' +
                'permissive behaviour. Check that _sandboxEnabled is read dynamically in ' +
                'isInsideAllowed, not cached at construction time.',
            ).resolves.toBeTruthy();
        },
    );

    it(
        'validateNewFilePath inside allowlist resolves when sandbox is ON',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);
            fsc.setSandboxEnabled(true);
            const result = await fsc.validateNewFilePath(path.join(tmpDir, 'new.txt'));
            expect(
                result,
                'validateNewFilePath for a new file inside the allowed dir must resolve.',
            ).toBe(path.join(realTmpDir, 'new.txt'));
        },
    );

    it(
        'validateNewFilePath outside allowlist throws when sandbox is ON',
        async () => {
            const { createFilesystemContext } = await importLib();
            const fsc = createFilesystemContext([tmpDir]);
            fsc.setSandboxEnabled(true);
            await expect(
                fsc.validateNewFilePath('/etc/some-new-zenith-regression-guard.conf'),
                'REGRESSION: validateNewFilePath did NOT throw for an outside-allowlist path ' +
                'when sandbox was enabled. The allowlist gate must apply to write targets too.',
            ).rejects.toThrow('Access denied');
        },
    );
});

// ---------------------------------------------------------------------------
// B. WIRING GUARD — ensure setSandboxEnabled wiring can't be orphaned again
// ---------------------------------------------------------------------------

describe('sandbox-opt-in — B. wiring guard: config flag wiring in server.ts', () => {
    const SERVER_TS = path.resolve(__dirname, '..', 'src', 'core', 'server.ts');
    const SCHEMA_TS = path.resolve(__dirname, '..', 'src', 'config', 'schema.ts');

    it(
        'server.ts references setSandboxEnabled to wire the config flag into the context',
        async () => {
            const source = await nodeFsPromises.readFile(SERVER_TS, 'utf8');
            expect(
                source.includes('setSandboxEnabled'),
                'REGRESSION: server.ts no longer calls setSandboxEnabled. ' +
                'The `sandbox` config flag is now ORPHANED — changing it in the config file ' +
                'has no effect on runtime enforcement. ' +
                'Fix: registerEnabledTools (or equivalent) must call ctx.setSandboxEnabled(syncedConfig.sandbox) ' +
                'before any tool is registered. See commit 7312e0d for the correct wiring.',
            ).toBe(true);
        },
    );

    it(
        'server.ts reads syncedConfig.sandbox to pass the opt-in flag to the context',
        async () => {
            const source = await nodeFsPromises.readFile(SERVER_TS, 'utf8');
            // The wiring must consume the `.sandbox` property from the loaded/synced config.
            // A bare `setSandboxEnabled(true)` or `setSandboxEnabled(false)` that ignores
            // the config field would make the flag a no-op from the operator's perspective.
            expect(
                source.includes('.sandbox'),
                'REGRESSION: server.ts calls setSandboxEnabled but does not read .sandbox from ' +
                'the loaded config. The config flag is wired but hard-coded, making `Sandbox: enabled` ' +
                'in the config file have no effect. ' +
                'Fix: pass syncedConfig.sandbox (or equivalent) to setSandboxEnabled — e.g. ' +
                'ctx.setSandboxEnabled?.(syncedConfig.sandbox).',
            ).toBe(true);
        },
    );

    it(
        'schema.ts still declares the sandbox field on ZenithConfig',
        async () => {
            const source = await nodeFsPromises.readFile(SCHEMA_TS, 'utf8');
            expect(
                source.includes('sandbox'),
                'REGRESSION: The `sandbox` field was removed from ZenithConfig in schema.ts. ' +
                'Without this field the config system cannot expose the opt-in flag and any ' +
                'wiring in server.ts will reference an undefined property (always falsy). ' +
                'Restore `sandbox: boolean` in the ZenithConfig interface and DEFAULT_CONFIG.',
            ).toBe(true);
        },
    );

    it(
        'schema.ts still sets sandbox default to false in DEFAULT_CONFIG',
        async () => {
            const source = await nodeFsPromises.readFile(SCHEMA_TS, 'utf8');
            // The default must be false — sandbox is OPT-IN.
            // If the default flips to true every existing deployment gets enforcement
            // switched on silently, potentially breaking access to legitimate paths.
            expect(
                source.includes('sandbox: false'),
                'REGRESSION: DEFAULT_CONFIG.sandbox is no longer explicitly false. ' +
                'The sandbox must default to OFF (opt-in). If the default flips to true, ' +
                'all existing deployments silently get enforcement turned on, which breaks ' +
                'the "allowed directories are project-context hints, not a hard sandbox" contract. ' +
                'Restore `sandbox: false` in DEFAULT_CONFIG.',
            ).toBe(true);
        },
    );
});
