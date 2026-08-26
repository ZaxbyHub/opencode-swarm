import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
	appendCoreEventSync,
	_internals as coreEventsInternals,
} from '../../../src/events/core-events.js';
import { getDiagnoseData } from '../../../src/services/diagnose-service.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

// Mock all the imported modules
vi.mock('../../../src/plan/manager.js', () => ({
	loadPlanJsonOnly: vi.fn(),
	closePlanTerminalState: async () => {},
	_snapshot_test_exports: {},
}));
vi.mock('../../../src/evidence/manager.js', () => ({
	listEvidenceTaskIds: vi.fn(),
}));
vi.mock('../../../src/hooks/utils.js', () => ({
	readSwarmFileAsync: vi.fn(),
	// #2268: diagnose's Coder Settlements check resolves paths via this stub.
	validateSwarmPath: (dir: string, file: string) => `${dir}/${file}`,
}));
vi.mock('../../../src/config/loader.js', () => ({
	loadPluginConfig: vi.fn(),
}));

// Spread the REAL node:fs exports (AGENTS.md invariant 7 / check-mock-cleanup
// Check 2): a partial mock replaces the module for every co-run test file in
// Bun's shared process and broke sibling suites relying on other exports.
import * as realFs from 'node:fs';

vi.mock('node:fs', () => ({
	...realFs,
	readdirSync: vi.fn(),
	existsSync: vi.fn(),
	statSync: vi.fn(),
	readFileSync: vi.fn(),
}));
vi.mock('node:child_process', () => ({
	execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { loadPluginConfig } from '../../../src/config/loader.js';
import { listEvidenceTaskIds } from '../../../src/evidence/manager.js';
import { readSwarmFileAsync } from '../../../src/hooks/utils.js';
// Import mocked modules
import { loadPlanJsonOnly } from '../../../src/plan/manager.js';

const mockLoadPlanJsonOnly = loadPlanJsonOnly as ReturnType<typeof vi.fn>;
const mockListEvidenceTaskIds = listEvidenceTaskIds as ReturnType<typeof vi.fn>;
const mockReadSwarmFileAsync = readSwarmFileAsync as ReturnType<typeof vi.fn>;
const mockLoadPluginConfig = loadPluginConfig as ReturnType<typeof vi.fn>;
const mockReaddirSync = readdirSync as ReturnType<typeof vi.fn>;
const mockExistsSync = existsSync as ReturnType<typeof vi.fn>;
const mockStatSync = statSync as ReturnType<typeof vi.fn>;
const mockExecSync = execSync as ReturnType<typeof vi.fn>;
const mockReadFileSync = readFileSync as ReturnType<typeof vi.fn>;

function findCheck(checks: any[], name: string) {
	return checks.find((c) => c.name === name);
}

/**
 * #2039: Checks D (Event Stream) and E (Steering Directives) now read
 * `.swarm/events.jsonl` through the core event store seam, whose `_internals`
 * captured the REAL `node:fs` bindings at module load — the file-wide
 * `vi.mock('node:fs')` scaffolding never intercepts it. Those tests therefore
 * use REAL fixtures in canonicalMkdtemp project dirs; raw fixture writes go
 * through `coreEventsInternals` (real fs, mock-free) since the test file's
 * own `node:fs` import is mocked.
 */
const realFixtureDirs: string[] = [];

function newProjectDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	realFixtureDirs.push(dir);
	coreEventsInternals.mkdirSync(join(dir, '.swarm'), { recursive: true });
	return dir;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockLoadPlanJsonOnly.mockResolvedValue(null);
	mockListEvidenceTaskIds.mockResolvedValue([]);
	mockReadSwarmFileAsync.mockResolvedValue(null);
	mockLoadPluginConfig.mockReturnValue(null);
	mockReaddirSync.mockReturnValue([]);
	// Default: no files exist except directory
	mockExistsSync.mockImplementation((path: any) => {
		if (typeof path !== 'string') return false;
		// Return true only for the test directory
		return (
			path === '/test/dir' ||
			path === '/test/dir/' ||
			path.endsWith('/test/dir') ||
			path.endsWith('\\test\\dir')
		);
	});
	mockStatSync.mockReturnValue({ isDirectory: () => true });
	mockExecSync.mockReturnValue(Buffer.from('.git'));
	mockReadFileSync.mockReturnValue('{}');
	delete process.env.OPENCODE_SWARM_ID;
});

afterEach(async () => {
	delete process.env.OPENCODE_SWARM_ID;
	for (const dir of realFixtureDirs) {
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}
	realFixtureDirs.length = 0;
});

describe('checkConfigParseability', () => {
	it('should pass when config file is missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Parseability');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'No project config file present (using defaults)',
		);
	});

	it('should pass when config file contains valid JSON', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.opencode/opencode-swarm.json') ||
				path.endsWith('.opencode\\opencode-swarm.json')
			);
		});
		mockReadFileSync.mockReturnValue('{"key": "value"}');

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Parseability');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('Project config is valid JSON');
	});

	it('should fail when config file contains invalid JSON', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.opencode/opencode-swarm.json') ||
				path.endsWith('.opencode\\opencode-swarm.json')
			);
		});
		mockReadFileSync.mockReturnValue('{"key": invalid json}');

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Parseability');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain(
			'Project config at .opencode/opencode-swarm.json is not valid JSON',
		);
	});

	it('should fail when config file is truncated', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.opencode/opencode-swarm.json') ||
				path.endsWith('.opencode\\opencode-swarm.json')
			);
		});
		mockReadFileSync.mockReturnValue('{"key": "value"');

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Config Parseability');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('not valid JSON');
	});
});

describe('checkGrammarWasmFiles', () => {
	it('should pass when all 17 grammar WASM files exist', async () => {
		mockExistsSync.mockReturnValue(true);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Grammar WASM Files');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'Core runtime + all 19 grammar WASM files present',
		);
	});

	it('should fail when some grammar WASM files are missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			// Return false for specific missing files
			if (typeof path !== 'string') return false;
			if (path.includes('tree-sitter-javascript.wasm')) return false;
			if (path.includes('tree-sitter-python.wasm')) return false;
			return true;
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Grammar WASM Files');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('2 WASM file(s) missing');
		expect(check.detail).toContain('tree-sitter-javascript.wasm');
		expect(check.detail).toContain('tree-sitter-python.wasm');
	});

	it('should fail when many grammar WASM files are missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			// Return false for all wasm files
			if (typeof path !== 'string') return false;
			if (path.includes('.wasm')) return false;
			return true;
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Grammar WASM Files');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('20 WASM file(s) missing');
	});
});

describe('checkCheckpointManifest', () => {
	it('should pass when checkpoint manifest is missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No checkpoint manifest (no checkpoints saved)');
	});

	it('should pass when checkpoint manifest is valid', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/checkpoints.json') ||
				path.endsWith('.swarm\\checkpoints.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				checkpoints: [
					{
						label: 'checkpoint-1',
						sha: 'abc123',
						timestamp: '2024-01-01T00:00:00Z',
					},
					{
						label: 'checkpoint-2',
						sha: 'def456',
						timestamp: '2024-01-02T00:00:00Z',
					},
				],
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain(
			'Checkpoint manifest valid — 2 checkpoint(s)',
		);
	});

	it('should fail when checkpoint manifest is not valid JSON', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/checkpoints.json') ||
				path.endsWith('.swarm\\checkpoints.json')
			);
		});
		mockReadFileSync.mockReturnValue('{"invalid": json}');

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toBe('checkpoints.json is not valid JSON');
	});

	it('should fail when checkpoint manifest is missing checkpoints array', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/checkpoints.json') ||
				path.endsWith('.swarm\\checkpoints.json')
			);
		});
		mockReadFileSync.mockReturnValue(JSON.stringify({ data: 'something' }));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toBe("checkpoints.json missing 'checkpoints' array");
	});

	it('should fail when checkpoints array has invalid structure', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/checkpoints.json') ||
				path.endsWith('.swarm\\checkpoints.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				checkpoints: [
					{ label: 'valid', sha: 'abc123', timestamp: '2024-01-01T00:00:00Z' },
					{ invalid: 'entry' }, // Missing label, sha, timestamp
					{ label: 'incomplete', sha: 'xyz789' }, // Missing timestamp
				],
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('2 checkpoint(s) have invalid structure');
	});

	it('should handle empty checkpoints array', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/checkpoints.json') ||
				path.endsWith('.swarm\\checkpoints.json')
			);
		});
		mockReadFileSync.mockReturnValue(JSON.stringify({ checkpoints: [] }));

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Checkpoint Manifest');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain(
			'Checkpoint manifest valid — 0 checkpoint(s)',
		);
	});
});

describe('checkEventStreamIntegrity', () => {
	it('should pass when events.jsonl is missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Event Stream');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No events.jsonl present');
	});

	it('should pass when events.jsonl has valid JSONL content', async () => {
		const dir = newProjectDir('diagnose-events-valid-');
		appendCoreEventSync(dir, { type: 'task-started', taskId: '1.1' });
		appendCoreEventSync(dir, { type: 'task-completed', taskId: '1.1' });
		appendCoreEventSync(dir, { type: 'phase-started', phase: 1 });

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Event Stream');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('events.jsonl is valid — 3 event(s)');
	});

	it('should pass when events.jsonl is empty', async () => {
		// #2039: a 0-byte events file is coverage 'empty' for the bounded
		// store — indistinguishable from absent — so the check now reports
		// 'No events.jsonl present' instead of 'valid — 0 event(s)'.
		const dir = newProjectDir('diagnose-events-empty-');
		coreEventsInternals.writeFileSync(join(dir, '.swarm', 'events.jsonl'), '');

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Event Stream');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe('No events.jsonl present');

		// A manifest-only store (all events folded away) reports an empty
		// retained window — the modern equivalent of "0 events".
		const manifestOnly = newProjectDir('diagnose-events-manifest-only-');
		coreEventsInternals.writeFileSync(
			join(manifestOnly, '.swarm', 'events.jsonl'),
			'{"v":1,"type":"swarm-events-manifest","schemaVersion":1,"folded":{"totalEvents":0,"byType":{},"corrupt":0,"dropped":0,"oldestTimestamp":null,"newestTimestamp":null},"updatedAt":"2026-08-25T00:00:00.000Z"}\n',
		);

		const manifestResult = await getDiagnoseData(manifestOnly);
		const manifestCheck = findCheck(manifestResult.checks, 'Event Stream');

		expect(manifestCheck).toBeDefined();
		expect(manifestCheck.status).toBe('✅');
		expect(manifestCheck.detail).toContain(
			'events.jsonl is valid — 0 event(s)',
		);
	});

	it('should fail when events.jsonl has malformed JSON lines', async () => {
		const dir = newProjectDir('diagnose-events-malformed-');
		appendCoreEventSync(dir, { type: 'task-started', taskId: '1.1' });
		coreEventsInternals.appendFileSync(
			join(dir, '.swarm', 'events.jsonl'),
			'{invalid json line}\n' +
				'{"type": "task-completed", "taskId": "1.1"}\n' +
				'{"broken": "json}\n',
		);

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Event Stream');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('events.jsonl has 2 malformed line(s)');
		expect(check.detail).toContain('possible data corruption');
	});

	it('should handle events.jsonl with trailing newlines and blank lines', async () => {
		const dir = newProjectDir('diagnose-events-blank-');
		coreEventsInternals.writeFileSync(
			join(dir, '.swarm', 'events.jsonl'),
			'{"type": "task-started", "taskId": "1.1"}\n\n' +
				'\n' +
				'{"type": "task-completed", "taskId": "1.1"}\n\n',
		);

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Event Stream');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('events.jsonl is valid — 2 event(s)');
	});
});

describe('checkSteeringDirectives', () => {
	it('should pass when events.jsonl is missing', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'No events.jsonl — no steering directives to check',
		);
	});

	it('should pass when no steering directives have been issued', async () => {
		const dir = newProjectDir('diagnose-steering-none-');
		appendCoreEventSync(dir, { type: 'task-started', taskId: '1.1' });
		appendCoreEventSync(dir, { type: 'task-completed', taskId: '1.1' });

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'All steering directives acknowledged (or none issued)',
		);
	});

	it('should pass when all steering directives have been consumed', async () => {
		const dir = newProjectDir('diagnose-steering-consumed-');
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-consumed',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-002',
		});
		appendCoreEventSync(dir, {
			type: 'steering-consumed',
			directiveId: 'dir-002',
		});

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'All steering directives acknowledged (or none issued)',
		);
	});

	it('should fail when some steering directives are not consumed', async () => {
		const dir = newProjectDir('diagnose-steering-unconsumed-');
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-002',
		});
		appendCoreEventSync(dir, {
			type: 'steering-consumed',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-003',
		});

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain(
			'2 steering directive(s) not yet acknowledged',
		);
	});

	it('should pass when events.jsonl has malformed lines (graceful handling)', async () => {
		const dir = newProjectDir('diagnose-steering-malformed-');
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-001',
		});
		coreEventsInternals.appendFileSync(
			join(dir, '.swarm', 'events.jsonl'),
			'invalid json line\n' +
				'{"type": "steering-consumed", "directiveId": "dir-001"}\n',
		);

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'All steering directives acknowledged (or none issued)',
		);
	});

	it('should handle empty events.jsonl', async () => {
		// #2039: a 0-byte events file is coverage 'empty' for the bounded
		// store — indistinguishable from absent — so the check takes the
		// 'No events.jsonl' gate instead of scanning an empty window. Still
		// a ✅ pass (no stale directives).
		const dir = newProjectDir('diagnose-steering-empty-');
		coreEventsInternals.writeFileSync(join(dir, '.swarm', 'events.jsonl'), '');

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toBe(
			'No events.jsonl — no steering directives to check',
		);
	});

	it('should fail when a directive is issued multiple times but not all consumed', async () => {
		const dir = newProjectDir('diagnose-steering-repeat-');
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-consumed',
			directiveId: 'dir-001',
		});
		appendCoreEventSync(dir, {
			type: 'steering-directive',
			directiveId: 'dir-002',
		});

		const result = await getDiagnoseData(dir);
		const check = findCheck(result.checks, 'Steering Directives');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain(
			'1 steering directive(s) not yet acknowledged',
		);
	});
});

describe('checkCurator', () => {
	it('should pass when curator is disabled', async () => {
		mockLoadPluginConfig.mockReturnValue({ curator: { enabled: false } });

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('Disabled');
		expect(check.detail).toContain('curator.enabled');
	});

	it('should pass when curator is enabled but no summary exists', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('no summary yet');
		expect(check.detail).toContain('waiting for first phase');
	});

	it('should pass when curator is enabled with valid summary', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/curator-summary.json') ||
				path.endsWith('.swarm\\curator-summary.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				schema_version: 1,
				last_phase_covered: 3,
				last_updated: '2026-03-19T10:00:00Z',
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('Summary present');
		expect(check.detail).toContain('phase 3');
	});

	it('should pass when curator is enabled with valid summary but no phase info', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/curator-summary.json') ||
				path.endsWith('.swarm\\curator-summary.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				schema_version: 1,
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('✅');
		expect(check.detail).toContain('Summary present');
		expect(check.detail).toContain('unknown phase');
	});

	it('should fail when curator is enabled but summary has corrupt JSON', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/curator-summary.json') ||
				path.endsWith('.swarm\\curator-summary.json')
			);
		});
		mockReadFileSync.mockReturnValue('{ invalid json content }');

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('corrupt');
		expect(check.detail).toContain('invalid');
	});

	it('should fail when curator is enabled but summary has wrong schema_version', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/curator-summary.json') ||
				path.endsWith('.swarm\\curator-summary.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				schema_version: 2,
				last_phase_covered: 1,
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('invalid schema_version');
		expect(check.detail).toContain('expected 1');
	});

	it('should fail when curator is enabled but schema_version is missing', async () => {
		mockLoadPluginConfig.mockReturnValue({
			curator: { enabled: true, init_enabled: true, phase_enabled: true },
		});
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir') ||
				path.endsWith('.swarm/curator-summary.json') ||
				path.endsWith('.swarm\\curator-summary.json')
			);
		});
		mockReadFileSync.mockReturnValue(
			JSON.stringify({
				last_phase_covered: 1,
			}),
		);

		const result = await getDiagnoseData('/test/dir');
		const check = findCheck(result.checks, 'Curator');

		expect(check).toBeDefined();
		expect(check.status).toBe('❌');
		expect(check.detail).toContain('invalid schema_version');
	});
});

describe('Integration - all 6 new checks together', () => {
	it('should include all 6 new health checks in the result', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');

		// Check that all 6 new checks are present
		expect(findCheck(result.checks, 'Config Parseability')).toBeDefined();
		expect(findCheck(result.checks, 'Grammar WASM Files')).toBeDefined();
		expect(findCheck(result.checks, 'Checkpoint Manifest')).toBeDefined();
		expect(findCheck(result.checks, 'Event Stream')).toBeDefined();
		expect(findCheck(result.checks, 'Steering Directives')).toBeDefined();
		expect(findCheck(result.checks, 'Curator')).toBeDefined();
	});

	it('should report correct total count including new checks', async () => {
		mockExistsSync.mockImplementation((path: any) => {
			if (typeof path !== 'string') return false;
			return (
				path === '/test/dir' ||
				path === '/test/dir/' ||
				path.endsWith('/test/dir') ||
				path.endsWith('\\test\\dir')
			);
		});

		const result = await getDiagnoseData('/test/dir');

		// Based on the existing code, we should have:
		// - plan.json/plan.md (1)
		// - context.md (1)
		// - Plugin config (1)
		// - Swarm Identity (1)
		// - Phase Boundaries (1)
		// - Orphaned Evidence (1)
		// - Plan Sync (1)
		// - Config Backups (1)
		// - Git Repository (1)
		// - Spec Staleness (1)
		// - Migration (0 or 1) - depends on plan
		// - Task DAG (0 or 1) - depends on plan
		// - Evidence (0 or 1) - depends on plan
		// + 6 new checks = ~12-15 checks total
		expect(result.totalCount).toBeGreaterThan(11);
	});
});
