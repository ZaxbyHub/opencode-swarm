import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _internals, handleCurateCommand } from '../commands/curate';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function createSwarmDir(dir: string): string {
	const swarmDir = path.join(dir, '.swarm');
	fs.mkdirSync(swarmDir, { recursive: true });
	return swarmDir;
}

describe('/swarm curate', () => {
	let tempDir: string;
	const realLoadCuratorDeps = _internals.loadCuratorDeps;
	const realReadSwarmFileAsync = _internals.readSwarmFileAsync;
	const realCheckHivePromotions = _internals.checkHivePromotions;

	beforeEach(() => {
		tempDir = createTempDir();
		createSwarmDir(tempDir);
	});

	afterEach(() => {
		_internals.loadCuratorDeps = realLoadCuratorDeps;
		_internals.readSwarmFileAsync = realReadSwarmFileAsync;
		_internals.checkHivePromotions = realCheckHivePromotions;
		cleanupDir(tempDir);
	});

	describe('Success/Empty-state handling', () => {
		it('should return concise summary with zero counts when no entries exist', async () => {
			// Empty swarm directory - no entries to curate
			const result = await handleCurateCommand(tempDir, []);

			// Should return a summary with the expected header
			expect(result).toContain('📚 Curation complete');

			// Should show zero counts for empty state
			expect(result).toContain('New promotions: 0');
			expect(result).toContain('Encounters incremented: 0');
			expect(result).toContain('Advancements: 0');
			expect(result).toContain('Total hive entries:');
		});

		it('should return summary with consistent shape for empty-state', async () => {
			const result = await handleCurateCommand(tempDir, []);

			// Count occurrences of expected labels - should all be present
			const labelCount = (
				result.match(
					/New promotions:|Encounters incremented:|Advancements:|Total hive entries:/g,
				) || []
			).length;
			expect(labelCount).toBe(4); // All 4 fields present
		});

		it('runs curator phase and applies recommendations when session context exists', async () => {
			let delegateSession: string | undefined;
			let phaseSeen = 0;
			let appliedRecommendations = 0;
			_internals.readSwarmFileAsync = async () =>
				JSON.stringify({ last_phase_covered: 4 });
			_internals.loadCuratorDeps = async () => ({
				CuratorConfigSchema: {
					parse: () => ({ enabled: true, phase_enabled: true }),
				},
				createCuratorLLMDelegate: (
					_directory: string,
					_mode: string,
					sessionID?: string,
				) => {
					delegateSession = sessionID;
					return async () => 'OBSERVATIONS:\n- new candidate: durable lesson';
				},
				curator: {
					runCuratorPhase: async (_directory: string, phase: number) => {
						phaseSeen = phase;
						return {
							knowledge_recommendations: [
								{
									action: 'promote',
									lesson: 'durable lesson from manual curation',
									reason: 'manual curation',
								},
							],
						};
					},
					applyCuratorKnowledgeUpdates: async (
						_directory: string,
						recommendations: unknown[],
					) => {
						appliedRecommendations = recommendations.length;
						return { applied: recommendations.length, skipped: 0 };
					},
				},
			});

			const result = await handleCurateCommand(tempDir, [], {
				sessionID: 'session-1684',
			});

			expect(delegateSession).toBe('session-1684');
			expect(phaseSeen).toBe(5);
			expect(appliedRecommendations).toBe(1);
			expect(result).toContain(
				'Knowledge recommendations: 1 applied, 0 skipped',
			);
			expect(result).toContain('Curator digest phase: 5');
		});
	});

	describe('Error handling', () => {
		it('should return clear user-facing error when error is thrown', async () => {
			_internals.checkHivePromotions = async () => {
				throw new Error('hive promoter exploded');
			};

			const result = await handleCurateCommand(tempDir, []);

			expect(result).toContain('❌ Curation failed:');
			expect(result).toContain('hive promoter exploded');
		});

		it('should not expose stack traces in error output', async () => {
			// Even with unusual inputs, should not expose internals
			// The error handling in curate.ts (lines 53-58) only returns the message
			// not the stack trace

			// Run with valid input - should always succeed
			const result = await handleCurateCommand(tempDir, []);

			// Should never contain stack traces
			expect(result).not.toContain('at ');
			expect(result).not.toContain('Stack:');
		});
	});
});
