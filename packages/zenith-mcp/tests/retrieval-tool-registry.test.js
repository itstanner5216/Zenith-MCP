import { describe, expect, it } from 'vitest';
import { ZenithToolRegistry, makeToolKey, hashToolList } from '../src/retrieval/zenith-tool-registry.ts';

describe('makeToolKey', () => {
  it('combines namespace and tool name with double underscore', () => {
    expect(makeToolKey('zenith', 'read_file')).toBe('zenith__read_file');
  });

  it('handles empty strings', () => {
    expect(makeToolKey('', '')).toBe('__');
  });

  it('preserves special characters in names', () => {
    expect(makeToolKey('ns', 'my-tool.v2')).toBe('ns__my-tool.v2');
  });
});

describe('hashToolList', () => {
  it('returns a 16-character hex string', () => {
    const tools = [{ name: 'read_file', inputSchema: { type: 'object' } }];
    const hash = hashToolList(tools);
    expect(hash).toHaveLength(16);
    expect(/^[0-9a-f]{16}$/.test(hash)).toBe(true);
  });

  it('produces same hash for same tools regardless of input order', () => {
    const tools1 = [
      { name: 'a', description: 'alpha', inputSchema: {} },
      { name: 'b', description: 'beta', inputSchema: {} },
    ];
    const tools2 = [
      { name: 'b', description: 'beta', inputSchema: {} },
      { name: 'a', description: 'alpha', inputSchema: {} },
    ];
    expect(hashToolList(tools1)).toBe(hashToolList(tools2));
  });

  it('produces different hash when tool description changes', () => {
    const tools1 = [{ name: 'x', description: 'old', inputSchema: {} }];
    const tools2 = [{ name: 'x', description: 'new', inputSchema: {} }];
    expect(hashToolList(tools1)).not.toBe(hashToolList(tools2));
  });
});

describe('ZenithToolRegistry', () => {
  function makeTool(name, props = {}) {
    return {
      name,
      inputSchema: { type: 'object', properties: {} },
      ...props,
    };
  }

  it('register stores a tool and returns the mapping', () => {
    const reg = new ZenithToolRegistry();
    const tool = makeTool('read_file');
    const mapping = reg.register(tool);
    expect(mapping.serverName).toBe('zenith');
    expect(mapping.tool.name).toBe('read_file');
  });

  it('get retrieves a registered tool by key', () => {
    const reg = new ZenithToolRegistry();
    reg.register(makeTool('edit_file'));
    const key = makeToolKey('zenith', 'edit_file');
    const result = reg.get(key);
    expect(result).toBeDefined();
    expect(result.tool.name).toBe('edit_file');
  });

  it('get returns undefined for unknown key', () => {
    const reg = new ZenithToolRegistry();
    expect(reg.get('zenith__nonexistent')).toBeUndefined();
  });

  it('register stores handler and inputZodSchema', () => {
    const reg = new ZenithToolRegistry();
    const handler = async () => ({ content: [] });
    const schema = { safeParse: () => ({ success: true }) };
    const mapping = reg.register(makeTool('test'), handler, schema);
    expect(mapping.handler).toBe(handler);
    expect(mapping.inputZodSchema).toBe(schema);
  });

  it('unregister removes a tool and returns true', () => {
    const reg = new ZenithToolRegistry();
    reg.register(makeTool('doomed'));
    expect(reg.unregister('doomed')).toBe(true);
    expect(reg.get(makeToolKey('zenith', 'doomed'))).toBeUndefined();
  });

  it('unregister returns false for non-existent tool', () => {
    const reg = new ZenithToolRegistry();
    expect(reg.unregister('ghost')).toBe(false);
  });

  it('list returns all registered mappings', () => {
    const reg = new ZenithToolRegistry();
    reg.register(makeTool('a'));
    reg.register(makeTool('b'));
    reg.register(makeTool('c'));
    const list = reg.list();
    expect(list).toHaveLength(3);
    expect(list.map(m => m.tool.name).sort()).toEqual(['a', 'b', 'c']);
  });

  it('register overwrites existing tool with same name', () => {
    const reg = new ZenithToolRegistry();
    reg.register(makeTool('x', { description: 'v1' }));
    reg.register(makeTool('x', { description: 'v2' }));
    const key = makeToolKey('zenith', 'x');
    expect(reg.get(key).tool.description).toBe('v2');
    expect(reg.list()).toHaveLength(1);
  });

  it('asRecord returns a shallow copy of all mappings', () => {
    const reg = new ZenithToolRegistry();
    reg.register(makeTool('foo'));
    const record = reg.asRecord();
    expect(record['zenith__foo']).toBeDefined();
    // Shallow copy — mutating record doesn't affect registry
    delete record['zenith__foo'];
    expect(reg.get('zenith__foo')).toBeDefined();
  });

  describe('asLiveRecord (Proxy)', () => {
    it('reflects registrations made after creation', () => {
      const reg = new ZenithToolRegistry();
      const live = reg.asLiveRecord();
      reg.register(makeTool('late'));
      expect(live['zenith__late']).toBeDefined();
      expect(live['zenith__late'].tool.name).toBe('late');
    });

    it('reflects unregistrations made after creation', () => {
      const reg = new ZenithToolRegistry();
      reg.register(makeTool('early'));
      const live = reg.asLiveRecord();
      expect(live['zenith__early']).toBeDefined();
      reg.unregister('early');
      expect(live['zenith__early']).toBeUndefined();
    });

    it('Object.keys returns current registry keys', () => {
      const reg = new ZenithToolRegistry();
      reg.register(makeTool('alpha'));
      reg.register(makeTool('beta'));
      const live = reg.asLiveRecord();
      expect(Object.keys(live).sort()).toEqual(['zenith__alpha', 'zenith__beta']);
    });
  });
});
