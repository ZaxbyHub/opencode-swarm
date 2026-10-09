// The dual-shape default export {id, server, setup} landed with the #3151 fix.
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../');
const PKG = path.join(ROOT, 'packages/opencode/dist');

describe('packaging smoke tests', () => {
    test('dist/index.js exists', () => {
        expect(existsSync(path.join(PKG, 'index.js'))).toBe(true);
    });

    test('dist/index.d.ts exists', () => {
        expect(existsSync(path.join(PKG, 'index.d.ts'))).toBe(true);
    });

    test('dist/cli/index.js exists', () => {
        expect(existsSync(path.join(PKG, 'cli/index.js'))).toBe(true);
    });

    test('dist/index.js is importable and exports the dual-shape default object', async () => {
        const mod = await import(path.join(PKG, 'index.js'));
        expect(typeof mod.default).toBe('object');
        expect(mod.default.id).toBe('opencode-swarm');
        expect(typeof mod.default.server).toBe('function');
        expect(typeof mod.default.setup).toBe('function');
    });

    test('plugin factory returns object with name property', async () => {
        const mod = await import(path.join(PKG, 'index.js'));
        // Call the plugin factory with a minimal context
        const plugin = await mod.default.server({ directory: ROOT });
        expect(plugin).toBeDefined();
        expect(typeof plugin.name).toBe('string');
        expect(plugin.name).toBe('opencode-swarm');
    });

    test('plugin factory returns object with hooks', async () => {
        const mod = await import(path.join(PKG, 'index.js'));
        const plugin = await mod.default.server({ directory: ROOT });
        // Plugin should have config and agent properties
        expect(plugin.config).toBeDefined();
        expect(typeof plugin.config).toBe('function');
    });

    test('dist/index.js file size is reasonable (< 5MB)', () => {
        const stats = Bun.file(path.join(PKG, 'index.js'));
        // Main bundle should be under 5MB
        expect(stats.size).toBeLessThan(5 * 1024 * 1024);
        // But should be at least 10KB (non-empty)
        expect(stats.size).toBeGreaterThan(10 * 1024);
    });

    test('dist/cli/index.js file size is reasonable (< 2MB)', () => {
        const stats = Bun.file(path.join(PKG, 'cli/index.js'));
        // CLI bundle should be under 2MB (raised from 1MB due to v6.17+ knowledge system additions)
        expect(stats.size).toBeLessThan(2 * 1024 * 1024);
        // But should be at least 1KB (non-empty)
        expect(stats.size).toBeGreaterThan(1 * 1024);
    });

    test('package.json has no postinstall script', async () => {
        const pkg = await import(path.join(ROOT, 'packages/opencode/package.json'), { with: { type: 'json' } });
        expect(pkg.default?.scripts?.postinstall).toBeUndefined();
    });

    test('dist/lang/grammars/ directory exists with WASM files', () => {
        const grammarsDir = path.join(PKG, 'lang/grammars');
        expect(existsSync(grammarsDir)).toBe(true);
        // Should contain at least one .wasm file
        const { readdirSync } = require('node:fs');
        const wasmFiles = readdirSync(grammarsDir).filter((f: string) => f.endsWith('.wasm'));
        expect(wasmFiles.length).toBeGreaterThan(0);
    });
});
