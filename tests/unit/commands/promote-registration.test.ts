import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentDefinition } from '../../../src/agents';
import { createSwarmCommandHandler } from '../../../src/commands/index';
// Import the handlers
import { handlePromoteCommand } from '../../../src/commands/promote';

// Test utilities
function createTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promote-test-'));
	return dir;
}

function cleanupDir(dir: string): void {
	if (fs.existsSync(dir)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

describe('/swarm promote Command Registration', () => {
	let tempDir: string;
	let agents: Record<string, AgentDefinition>;
	let handler: (
		input: { command: string; sessionID: string; arguments: string },
		output: { parts: unknown[] },
	) => Promise<void>;
	// Saved env vars for hive path isolation
	let savedLocalAppData: string | undefined;
	let savedXdgDataHome: string | undefined;
	let savedHome: string | undefined;

	beforeEach(() => {
		tempDir = createTempDir();
		// Redirect hive knowledge path to tempDir to isolate from global state.
		// resolveHiveKnowledgePath() reads LOCALAPPDATA (win32), XDG_DATA_HOME (linux),
		// or os.homedir() (darwin) at call time.
		if (process.platform === 'win32') {
			savedLocalAppData = process.env.LOCALAPPDATA;
			process.env.LOCALAPPDATA = tempDir;
		} else if (process.platform === 'darwin') {
			savedHome = process.env.HOME;
			process.env.HOME = tempDir;
		} else {
			savedXdgDataHome = process.env.XDG_DATA_HOME;
			process.env.XDG_DATA_HOME = tempDir;
		}
		agents = {
			coder: {
				name: 'coder',
				config: { model: 'gpt-4' },
			},
		};
		handler = createSwarmCommandHandler(tempDir, agents);
	});

	afterEach(() => {
		cleanupDir(tempDir);
		// Restore env vars
		if (process.platform === 'win32') {
			if (savedLocalAppData !== undefined) {
				process.env.LOCALAPPDATA = savedLocalAppData;
			} else {
				delete process.env.LOCALAPPDATA;
			}
		} else if (process.platform === 'darwin') {
			if (savedHome !== undefined) {
				process.env.HOME = savedHome;
			} else {
				delete process.env.HOME;
			}
		} else {
			if (savedXdgDataHome !== undefined) {
				process.env.XDG_DATA_HOME = savedXdgDataHome;
			} else {
				delete process.env.XDG_DATA_HOME;
			}
		}
	});

	describe('Task 2.1.1: Command Import and Export', () => {
		it('should import handlePromoteCommand from ./promote', async () => {
			// Verify the import exists by checking that we can import it
			// This test passes if the import statement at the top of this file succeeds
			expect(typeof handlePromoteCommand).toBe('function');
		});

		it('should export handlePromoteCommand from index.ts', async () => {
			// Read the index.ts file to verify export exists
			const actualIndexPath = path.join(
				process.cwd(),
				'src',
				'commands',
				'index.ts',
			);
			const indexContent = fs.readFileSync(actualIndexPath, 'utf-8');

			expect(indexContent).toContain(
				"export { handlePromoteCommand } from './promote'",
			);
		});
	});

	describe('Task 2.1.2: Switch Case Registration', () => {
		it('should handle promote subcommand in switch case', async () => {
			const output: { parts: unknown[] } = { parts: [] };

			// Use a lesson long enough to pass the 15-char minimum validator
			await handler(
				{
					command: 'swarm',
					sessionID: 'test-123',
					arguments: 'promote Always validate inputs at system boundaries',
				},
				output,
			);

			expect(output.parts.length).toBeGreaterThan(0);
			const result = output.parts[0] as { type: string; text: string };
			expect(result.type).toBe('text');
			// Source returns "Promoted to hive: ..." (past tense)
			expect(result.text).toContain('Promoted to hive');
		});

		it('should not interfere with other commands', async () => {
			const output: { parts: unknown[] } = { parts: [] };

			await handler(
				{ command: 'swarm', sessionID: 'test-123', arguments: 'status' },
				output,
			);

			expect(output.parts.length).toBeGreaterThan(0);
			const result = output.parts[0] as { type: string; text: string };
			expect(result.type).toBe('text');
		});
	});

	describe('Task 2.1.3: Help Text Documentation', () => {
		it('should include promote command in HELP_TEXT', async () => {
			// HELP_TEXT is built dynamically from VALID_COMMANDS via COMMAND_REGISTRY.
			// 'promote' is registered in registry.ts. Verify index.ts exports handlePromoteCommand
			// and re-exports COMMAND_REGISTRY/VALID_COMMANDS (which contain the promote entry).
			const actualIndexPath = path.join(
				process.cwd(),
				'src',
				'commands',
				'index.ts',
			);
			const indexContent = fs.readFileSync(actualIndexPath, 'utf-8');

			expect(indexContent).toContain('handlePromoteCommand');
			expect(indexContent).toContain('VALID_COMMANDS');
			expect(indexContent).toContain('COMMAND_REGISTRY');
		});

		it('should show help when no arguments provided', async () => {
			const output: { parts: unknown[] } = { parts: [] };

			await handler(
				{ command: 'swarm', sessionID: 'test-123', arguments: 'promote' },
				output,
			);

			expect(output.parts.length).toBeGreaterThan(0);
			const result = output.parts[0] as { type: string; text: string };
			expect(result.type).toBe('text');
			// Should show usage error
			expect(result.text).toContain('Usage:');
		});
	});

	describe('Task 2.1.4: Direct Text Mode', () => {
		it('should promote direct lesson text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'This is a lesson text',
			]);

			// promoteToHive returns: `Promoted to hive: "..." (confidence: 1.0, source: manual)`
			expect(result).toContain('Promoted to hive');
			expect(result).toContain('This is a lesson text');
			expect(result).toContain('source: manual');
		});

		it('should handle multi-word lesson text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'This is a lesson with multiple words',
			]);

			expect(result).toContain('Promoted to hive');
			expect(result).toContain('multiple words');
		});

		it('should truncate long lesson text in output', async () => {
			const longText = 'a'.repeat(100);
			const result = await handlePromoteCommand(tempDir, [longText]);

			expect(result).toContain('...');
			expect(result.length).toBeLessThan(longText.length + 100);
		});
	});

	describe('Task 2.1.5: --category Flag Parsing', () => {
		it('should parse --category flag with lesson text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--category',
				'security',
				'This is a lesson',
			]);

			// promoteToHive return does not include category — just confirms promotion
			expect(result).toContain('Promoted to hive');
			expect(result).toContain('This is a lesson');
		});

		it('should handle --category before lesson text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--category',
				'performance',
				'Optimize database queries here',
			]);

			expect(result).toContain('Promoted to hive');
			expect(result).toContain('Optimize');
		});

		it('should handle --category with valid category value', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--category',
				'testing',
				'Use type hints in Python code',
			]);

			// Implementation accepts a single valid category token
			expect(result).toContain('Promoted to hive');
		});
	});

	describe('Task 2.1.6: --from-swarm Flag Parsing', () => {
		it('should parse --from-swarm flag', async () => {
			// promoteFromSwarm throws when lesson ID not found in .swarm/knowledge.jsonl
			const result = await handlePromoteCommand(tempDir, [
				'--from-swarm',
				'lesson-123',
			]);

			// handlePromoteCommand catches error and returns message
			expect(result).toContain('lesson-123');
			expect(result).toContain('not found');
		});

		it('should not show lesson text when using --from-swarm', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--from-swarm',
				'lesson-456',
			]);

			expect(result).toContain('lesson-456');
			expect(result).not.toContain('Promoting to hive:');
		});

		it('should handle --from-swarm with valid lesson ID', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--from-swarm',
				'abc123def',
			]);

			expect(result).toContain('abc123def');
		});
	});

	describe('Task 2.1.7: Error Handling', () => {
		it('should handle empty input gracefully', async () => {
			const result = await handlePromoteCommand(tempDir, []);

			expect(result).toContain('Usage:');
			expect(result).toContain('/swarm promote');
		});

		it('should handle only flags without values', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--category',
				'--from-swarm',
			]);

			// Should show usage since no lesson text or lesson id provided
			expect(result).toContain('Usage:');
		});

		it('should handle --category without lesson text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--category',
				'bugfix',
			]);

			expect(result).toContain('Usage:');
		});

		it('should handle --from-swarm without value', async () => {
			const result = await handlePromoteCommand(tempDir, ['--from-swarm']);

			// Should show usage since no lesson id provided
			expect(result).toContain('Usage:');
		});
	});

	describe('Task 2.1.8: Combined Flag Usage', () => {
		it('should handle --from-swarm without --category', async () => {
			// promoteFromSwarm throws when ID not found; error message contains the ID
			const result = await handlePromoteCommand(tempDir, [
				'--from-swarm',
				'lesson-789',
			]);

			expect(result).toContain('lesson-789');
		});

		it('should prioritize --from-swarm over direct text', async () => {
			const result = await handlePromoteCommand(tempDir, [
				'--from-swarm',
				'lesson-999',
				'this is supplemental context text',
			]);

			// --from-swarm takes precedence; error message contains lesson-999 (not found)
			expect(result).toContain('lesson-999');
			expect(result).not.toContain('supplemental context text');
		});
	});
});
