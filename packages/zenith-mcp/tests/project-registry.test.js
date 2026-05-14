import { describe, expect, it } from 'vitest';
import path from 'path';
import { ProjectRegistry } from '../dist/core/project-registry.js';

const makeManifest = (id, name, root) => ({
    project_id: id,
    project_name: name,
    project_root: root,
});

const FIXTURE_DIR = '/tmp/test-projects';

describe('ProjectRegistry constructor', () => {
    it('creates empty registry with no args', () => {
        const reg = new ProjectRegistry();
        expect(reg.listProjects()).toEqual([]);
    });

    it('accepts array of manifests', () => {
        const m = makeManifest('a', 'Alpha', '/alpha');
        const reg = new ProjectRegistry([m]);
        expect(reg.listProjects()).toHaveLength(1);
    });

    it('accepts a Map of manifests', () => {
        const m = makeManifest('b', 'Beta', '/beta');
        const map = new Map([['b', m]]);
        const reg = new ProjectRegistry(map);
        expect(reg.listProjects()).toHaveLength(1);
    });
});

describe('ProjectRegistry register/unregister', () => {
    it('register adds a project retrievable by id', () => {
        const reg = new ProjectRegistry();
        const m = makeManifest('proj-1', 'My Project', '/proj1');
        reg.register(m);
        expect(reg.getById('proj-1')).toBe(m);
    });

    it('register overwrites duplicate id', () => {
        const reg = new ProjectRegistry();
        reg.register(makeManifest('dup', 'First', '/first'));
        reg.register(makeManifest('dup', 'Second', '/second'));
        expect(reg.listProjects()).toHaveLength(1);
        expect(reg.getById('dup').project_name).toBe('Second');
    });

    it('register stores by name for name lookup', () => {
        const reg = new ProjectRegistry();
        const m = makeManifest('id1', 'UniqueName', '/root');
        reg.register(m);
        expect(reg.findProject('UniqueName')).toBe(m);
    });

    it('register handles missing project_name gracefully', () => {
        const reg = new ProjectRegistry();
        const m = { project_id: 'no-name', project_name: undefined, project_root: '/no-name' };
        reg.register(m);
        expect(reg.getById('no-name')).toBe(m);
        expect(reg.listProjects()).toHaveLength(1);
    });

    it('unregister removes project from all lookups', () => {
        const reg = new ProjectRegistry();
        const m = makeManifest('rm-me', 'Remove Me', '/rm');
        reg.register(m);
        reg.unregister('rm-me');
        expect(reg.getById('rm-me')).toBeNull();
        expect(reg.findProject('Remove Me')).toBeNull();
        expect(reg.findProject('/rm')).toBeNull();
        expect(reg.listProjects()).toHaveLength(0);
    });

    it('unregister is a no-op for unknown id', () => {
        const reg = new ProjectRegistry();
        reg.unregister('nonexistent');
        expect(reg.listProjects()).toHaveLength(0);
    });
});

describe('ProjectRegistry findProject — matching strategy', () => {
    const alpha = makeManifest('alpha', 'Alpha Service', `${FIXTURE_DIR}/alpha`);
    const beta = makeManifest('beta-api', 'Beta API', `${FIXTURE_DIR}/beta`);
    const gamma = makeManifest('gamma', 'Gamma Deep', `${FIXTURE_DIR}/gamma/sub`);

    function makeRegistry() {
        return new ProjectRegistry([alpha, beta, gamma]);
    }

    it('returns null for empty or whitespace-only input', () => {
        const reg = makeRegistry();
        expect(reg.findProject('')).toBeNull();
        expect(reg.findProject('   ')).toBeNull();
        expect(reg.findProject(null)).toBeNull();
        expect(reg.findProject(undefined)).toBeNull();
    });

    it('step 1: exact match on project_id (case-insensitive)', () => {
        const reg = makeRegistry();
        expect(reg.findProject('alpha')).toBe(alpha);
        expect(reg.findProject('ALPHA')).toBe(alpha);
        expect(reg.findProject('Alpha')).toBe(alpha);
    });

    it('step 2: exact match on project_name (case-insensitive)', () => {
        const reg = makeRegistry();
        expect(reg.findProject('Alpha Service')).toBe(alpha);
        expect(reg.findProject('alpha service')).toBe(alpha);
        expect(reg.findProject('BETA API')).toBe(beta);
    });

    it('step 3: leading path-segment match extracts first segment and matches id', () => {
        const reg = makeRegistry();
        expect(reg.findProject('beta-api/src/server.ts')).toBe(beta);
    });

    it('step 3: leading path-segment match extracts first segment and matches name', () => {
        const reg = makeRegistry();
        expect(reg.findProject('Alpha Service/deep/path')).toBe(alpha);
    });

    it('step 4: exact match on normalized project_root path', () => {
        const reg = makeRegistry();
        const result = reg.findProject(path.resolve(`${FIXTURE_DIR}/alpha`));
        expect(result).toBe(alpha);
    });

    it('step 5: path-prefix match picks longest root', () => {
        const reg = makeRegistry();
        const result = reg.findProject(`${FIXTURE_DIR}/gamma/sub/deep/file.ts`);
        expect(result).toBe(gamma);
    });

    it('step 5: path-prefix match with exact root path', () => {
        const reg = makeRegistry();
        const result = reg.findProject(path.resolve(`${FIXTURE_DIR}/gamma/sub`));
        expect(result).toBe(gamma);
    });

    it('returns null when nothing matches', () => {
        const reg = makeRegistry();
        expect(reg.findProject('nonexistent')).toBeNull();
    });
});

describe('ProjectRegistry findProjectRoot', () => {
    it('returns project_root on match', () => {
        const reg = new ProjectRegistry();
        reg.register(makeManifest('x', 'X Project', '/x-root'));
        expect(reg.findProjectRoot('x')).toBe('/x-root');
    });

    it('returns null on no match', () => {
        const reg = new ProjectRegistry();
        expect(reg.findProjectRoot('nothing')).toBeNull();
    });
});

describe('ProjectRegistry getById / lookup', () => {
    it('getById is case-insensitive', () => {
        const reg = new ProjectRegistry();
        const m = makeManifest('CaseID', 'Test', '/test');
        reg.register(m);
        expect(reg.getById('caseid')).toBe(m);
        expect(reg.getById('CASEID')).toBe(m);
        expect(reg.getById('CaseID')).toBe(m);
    });

    it('getById returns null for unknown id', () => {
        const reg = new ProjectRegistry();
        expect(reg.getById('unknown')).toBeNull();
    });

    it('lookup is an alias for getById', () => {
        const reg = new ProjectRegistry();
        reg.register(makeManifest('lkp', 'Lookup Test', '/lkp'));
        expect(reg.lookup('lkp')).toBe(reg.getById('lkp'));
    });
});

describe('ProjectRegistry listProjects', () => {
    it('returns all registered manifests', () => {
        const reg = new ProjectRegistry();
        const m1 = makeManifest('a', 'A', '/a');
        const m2 = makeManifest('b', 'B', '/b');
        reg.register(m1);
        reg.register(m2);
        const list = reg.listProjects();
        expect(list).toHaveLength(2);
        expect(list).toContainEqual(m1);
        expect(list).toContainEqual(m2);
    });
});
