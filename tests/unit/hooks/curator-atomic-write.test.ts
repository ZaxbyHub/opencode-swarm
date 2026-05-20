import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	filterPhaseEvents,
	readCuratorSummary,
	writeCuratorSummary,
} from '../../../src/hooks/curator.js';
import type { CuratorSummary } from '../../../src/hooks/curator-types';

describe('curator atomic write', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'curator-atomic-test-'));
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	describe('writeCuratorSummary', () => {
		test('creates file with correct content', async () => {
			const summary: CuratorSummary = {
				schema_version: 1,
				session_id: 'atomic-test-session',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 3,
				digest: 'Phase 1 done\nPhase 2 done\nPhase 3 done',
				phase_digests: [
					{
						phase: 1,
						timestamp: '2024-01-15T09:00:00.000Z',
						summary: 'Phase 1 completed',
						agents_used: ['coder', 'reviewer'],
						tasks_completed: 5,
						tasks_total: 5,
						key_decisions: ['decision1'],
						blockers_resolved: [],
					},
				],
				compliance_observations: [],
				knowledge_recommendations: [],
			};

			await writeCuratorSummary(tempDir, summary);

			const filePath = path.join(tempDir, '.swarm', 'curator-summary.json');
			expect(fs.existsSync(filePath)).toBe(true);

			const content = fs.readFileSync(filePath, 'utf-8');
			const parsed = JSON.parse(content);
			expect(parsed.schema_version).toBe(1);
			expect(parsed.session_id).toBe('atomic-test-session');
			expect(parsed.last_phase_covered).toBe(3);
			expect(parsed.digest).toBe('Phase 1 done\nPhase 2 done\nPhase 3 done');
			expect(parsed.phase_digests).toHaveLength(1);
		});

		test('after write, readCuratorSummary reads file back successfully', async () => {
			const summary: CuratorSummary = {
				schema_version: 1,
				session_id: 'readback-test',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 1,
				digest: 'Initial phase',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			};

			await writeCuratorSummary(tempDir, summary);
			const result = await readCuratorSummary(tempDir);

			expect(result).not.toBeNull();
			expect(result?.session_id).toBe('readback-test');
			expect(result?.last_phase_covered).toBe(1);
			expect(result?.schema_version).toBe(1);
		});

		test('file content is valid JSON with schema_version: 1', async () => {
			const summary: CuratorSummary = {
				schema_version: 1,
				session_id: 'schema-version-test',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 2,
				digest: 'Test digest',
				phase_digests: [
					{
						phase: 2,
						timestamp: '2024-01-15T11:00:00.000Z',
						summary: 'Phase 2 summary',
						agents_used: ['coder'],
						tasks_completed: 3,
						tasks_total: 3,
						key_decisions: [],
						blockers_resolved: ['blocker1'],
					},
				],
				compliance_observations: [
					{
						phase: 1,
						timestamp: '2024-01-15T10:00:00.000Z',
						type: 'missing_reviewer',
						description: 'No reviewer in phase 1',
						severity: 'warning',
					},
				],
				knowledge_recommendations: [
					{
						action: 'promote',
						entry_id: 'entry-1',
						lesson: 'Test lesson',
						reason: 'Test reason',
					},
				],
			};

			await writeCuratorSummary(tempDir, summary);

			const filePath = path.join(tempDir, '.swarm', 'curator-summary.json');
			const content = fs.readFileSync(filePath, 'utf-8');

			// Should be valid JSON (not throw)
			let parsed: unknown;
			expect(() => {
				parsed = JSON.parse(content);
			}).not.toThrow();

			// Verify schema_version is 1
			expect((parsed as CuratorSummary).schema_version).toBe(1);
			expect((parsed as CuratorSummary).phase_digests).toHaveLength(1);
			expect((parsed as CuratorSummary).compliance_observations).toHaveLength(
				1,
			);
			expect((parsed as CuratorSummary).knowledge_recommendations).toHaveLength(
				1,
			);
		});

		test('no temp files left after successful write', async () => {
			const summary: CuratorSummary = {
				schema_version: 1,
				session_id: 'no-temp-files-test',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 1,
				digest: 'Test',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			};

			await writeCuratorSummary(tempDir, summary);

			// List all files in .swarm directory
			const swarmDir = path.join(tempDir, '.swarm');
			const files = fs.readdirSync(swarmDir);

			// Should only have curator-summary.json, no .tmp.* files
			const tempFiles = files.filter((f) => f.includes('.tmp.'));
			expect(tempFiles).toHaveLength(0);

			// Should have exactly the curator-summary.json file
			expect(files).toEqual(['curator-summary.json']);
		});

		test('temp files are in .swarm directory if they exist (atomic rename completes)', async () => {
			// This test verifies the atomic write pattern: temp file is renamed to final path
			// The temp file should NOT exist after write completes
			const summary: CuratorSummary = {
				schema_version: 1,
				session_id: 'temp-location-test',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 1,
				digest: 'Test',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			};

			await writeCuratorSummary(tempDir, summary);

			const swarmDir = path.join(tempDir, '.swarm');
			const allFiles = fs.readdirSync(swarmDir, { recursive: true });

			// No file should have .tmp. in its name
			for (const file of allFiles) {
				const fileStr = typeof file === 'string' ? file : String(file);
				expect(fileStr).not.toContain('.tmp.');
			}

			// The final file should exist
			const finalPath = path.join(swarmDir, 'curator-summary.json');
			expect(fs.existsSync(finalPath)).toBe(true);
		});

		test('multiple sequential writes do not leave temp files', async () => {
			const swarmDir = path.join(tempDir, '.swarm');

			// First write
			await writeCuratorSummary(tempDir, {
				schema_version: 1,
				session_id: 'multi-write-1',
				last_updated: '2024-01-15T12:00:00.000Z',
				last_phase_covered: 1,
				digest: 'First',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			// Second write
			await writeCuratorSummary(tempDir, {
				schema_version: 1,
				session_id: 'multi-write-2',
				last_updated: '2024-01-15T13:00:00.000Z',
				last_phase_covered: 2,
				digest: 'Second',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			// Third write
			await writeCuratorSummary(tempDir, {
				schema_version: 1,
				session_id: 'multi-write-3',
				last_updated: '2024-01-15T14:00:00.000Z',
				last_phase_covered: 3,
				digest: 'Third',
				phase_digests: [],
				compliance_observations: [],
				knowledge_recommendations: [],
			});

			// Check no temp files remain
			const files = fs.readdirSync(swarmDir);
			const tempFiles = files.filter((f) => f.includes('.tmp.'));
			expect(tempFiles).toHaveLength(0);

			// Verify final content is from third write
			const result = await readCuratorSummary(tempDir);
			expect(result?.session_id).toBe('multi-write-3');
			expect(result?.last_phase_covered).toBe(3);
		});
	});

	describe('filterPhaseEvents DEBUG_SWARM gating', () => {
		const originalDebugSwarm = process.env.DEBUG_SWARM;

		afterEach(() => {
			// Restore original DEBUG_SWARM
			if (originalDebugSwarm === undefined) {
				delete process.env.DEBUG_SWARM;
			} else {
				process.env.DEBUG_SWARM = originalDebugSwarm;
			}
		});

		test('when DEBUG_SWARM is not set, malformed lines do not produce console.warn output', () => {
			// Ensure DEBUG_SWARM is not set
			delete process.env.DEBUG_SWARM;

			const consoleWarnSpy = spyOn(console, 'warn');

			const jsonl = `{"type": "valid", "phase": 1}
malformed json line that should be skipped
{"type": "also_valid", "phase": 1}`;

			const result = filterPhaseEvents(jsonl, 1);

			// Should still parse valid events
			expect(result).toHaveLength(2);

			// Should NOT have called console.warn since DEBUG_SWARM is not set
			expect(consoleWarnSpy).not.toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});

		test('when OPENCODE_SWARM_DEBUG is set, malformed lines produce console.warn output', () => {
			process.env.OPENCODE_SWARM_DEBUG = '1';

			const consoleWarnSpy = spyOn(console, 'warn');

			const jsonl = `{"type": "valid", "phase": 1}
malformed json line that should be skipped
{"type": "also_valid", "phase": 1}`;

			const result = filterPhaseEvents(jsonl, 1);

			// Should still parse valid events
			expect(result).toHaveLength(2);

			// Should have called console.warn since OPENCODE_SWARM_DEBUG is set
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
			delete process.env.OPENCODE_SWARM_DEBUG;
		});

		test('valid events are returned regardless of DEBUG_SWARM setting', () => {
			const jsonl = `{"type": "event1", "phase": 2, "timestamp": "2024-01-15T10:00:00Z"}
{"type": "event2", "phase": 2, "timestamp": "2024-01-15T10:01:00Z"}`;

			// Test with DEBUG_SWARM not set
			delete process.env.DEBUG_SWARM;
			const result1 = filterPhaseEvents(jsonl, 2);
			expect(result1).toHaveLength(2);

			// Test with DEBUG_SWARM set
			process.env.DEBUG_SWARM = '1';
			const result2 = filterPhaseEvents(jsonl, 2);
			expect(result2).toHaveLength(2);
		});

		test('empty lines are skipped regardless of DEBUG_SWARM', () => {
			const jsonl = `{"type": "event1", "phase": 1}

{"type": "event2", "phase": 1}`;

			// With DEBUG_SWARM not set
			delete process.env.DEBUG_SWARM;
			const result1 = filterPhaseEvents(jsonl, 1);
			expect(result1).toHaveLength(2);

			// With DEBUG_SWARM set
			process.env.DEBUG_SWARM = '1';
			const result2 = filterPhaseEvents(jsonl, 1);
			expect(result2).toHaveLength(2);
		});
	});
});
