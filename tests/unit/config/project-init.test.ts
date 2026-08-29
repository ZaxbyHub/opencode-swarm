import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	writeProjectConfigIfNew,
	writeSwarmConfigExampleIfNew,
} from '../../../src/config/project-init';
import { clearDeferredWarnings } from '../../../src/services/warning-buffer';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

describe('writeProjectConfigIfNew', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-project-init-'));
		clearDeferredWarnings();
	});

	afterEach(() => {
		clearDeferredWarnings();
		cleanup();
	});

	const configPath = (d: string) =>
		path.join(d, '.opencode', 'opencode-swarm.json');

	test('does not create .opencode/opencode-swarm.json', () => {
		writeProjectConfigIfNew(dir);
		expect(fs.existsSync(configPath(dir))).toBe(false);
	});

	test('does not create .opencode directory', () => {
		writeProjectConfigIfNew(dir);
		expect(fs.existsSync(path.join(dir, '.opencode'))).toBe(false);
	});

	test('does not throw', () => {
		expect(() => writeProjectConfigIfNew(dir, true)).not.toThrow();
	});
});

describe('writeSwarmConfigExampleIfNew', () => {
	let dir: string;
	let cleanup: () => void;

	beforeEach(() => {
		({ dir, cleanup } = createSafeTestDir('swarm-example-init-'));
	});

	afterEach(() => {
		cleanup();
	});

	const examplePath = (d: string) =>
		path.join(d, '.swarm', 'config.example.json');

	test('10. creates .swarm/config.example.json and .swarm/ when absent', () => {
		writeSwarmConfigExampleIfNew(dir);
		expect(fs.existsSync(examplePath(dir))).toBe(true);
		expect(fs.existsSync(path.join(dir, '.swarm'))).toBe(true);
	});

	test('11. written file is valid JSON with an agents key', () => {
		writeSwarmConfigExampleIfNew(dir);
		const raw = fs.readFileSync(examplePath(dir), 'utf-8');
		const parsed = JSON.parse(raw);
		expect(typeof parsed).toBe('object');
		expect(parsed).not.toBeNull();
		expect(typeof parsed.agents).toBe('object');
	});

	test('12. does not overwrite an existing config.example.json', () => {
		const swarmDir = path.join(dir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		const sentinel = '{"sentinel":true}\n';
		fs.writeFileSync(examplePath(dir), sentinel, 'utf-8');

		writeSwarmConfigExampleIfNew(dir);

		expect(fs.readFileSync(examplePath(dir), 'utf-8')).toBe(sentinel);
	});
});
