/**
 * cli-dispatch.test.ts
 *
 * Registry-level tests for the unified command dispatch system.
 * These tests verify the COMMAND_REGISTRY and resolveCommand() function
 * independently of the CLI or hook entry points.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

afterEach(() => {
	mock.restore();
});

// Mock all individual command files so we can import the registry
// without triggering real I/O in handler modules
mock.module('../../src/commands/status.js', () => ({
	handleStatusCommand: mock(),
}));
mock.module('../../src/commands/plan.js', () => ({
	handlePlanCommand: mock(),
}));
mock.module('../../src/commands/agents.js', () => ({
	handleAgentsCommand: mock(),
}));
mock.module('../../src/commands/archive.js', () => ({
	handleArchiveCommand: mock(),
}));
mock.module('../../src/commands/history.js', () => ({
	handleHistoryCommand: mock(),
}));
mock.module('../../src/commands/config.js', () => ({
	handleConfigCommand: mock(),
}));
mock.module('../../src/commands/doctor.js', () => ({
	handleDoctorCommand: mock(),
}));
mock.module('../../src/commands/evidence.js', () => ({
	handleEvidenceCommand: mock(),
	handleEvidenceSummaryCommand: mock(),
}));
mock.module('../../src/commands/diagnose.js', () => ({
	handleDiagnoseCommand: mock(),
}));
mock.module('../../src/commands/preflight.js', () => ({
	handlePreflightCommand: mock(),
}));
mock.module('../../src/commands/sync-plan.js', () => ({
	handleSyncPlanCommand: mock(),
}));
mock.module('../../src/commands/benchmark.js', () => ({
	handleBenchmarkCommand: mock(),
}));
mock.module('../../src/commands/export.js', () => ({
	handleExportCommand: mock(),
}));
mock.module('../../src/commands/reset.js', () => ({
	handleResetCommand: mock(),
}));
mock.module('../../src/commands/retrieve.js', () => ({
	handleRetrieveCommand: mock(),
}));
mock.module('../../src/commands/clarify.js', () => ({
	handleClarifyCommand: mock(),
}));
mock.module('../../src/commands/analyze.js', () => ({
	handleAnalyzeCommand: mock(),
}));
mock.module('../../src/commands/specify.js', () => ({
	handleSpecifyCommand: mock(),
}));
mock.module('../../src/commands/dark-matter.js', () => ({
	handleDarkMatterCommand: mock(),
}));
mock.module('../../src/commands/knowledge.js', () => ({
	handleKnowledgeListCommand: mock(),
	handleKnowledgeMigrateCommand: mock(),
	handleKnowledgeQuarantineCommand: mock(),
	handleKnowledgeRestoreCommand: mock(),
}));
mock.module('../../src/commands/rollback.js', () => ({
	handleRollbackCommand: mock(),
}));
mock.module('../../src/commands/promote.js', () => ({
	handlePromoteCommand: mock(),
}));
mock.module('../../src/commands/handoff.js', () => ({
	handleHandoffCommand: mock(),
}));
mock.module('../../src/commands/turbo.js', () => ({
	handleTurboCommand: mock(),
}));
mock.module('../../src/commands/simulate.js', () => ({
	handleSimulateCommand: mock(),
}));
mock.module('../../src/commands/curate.js', () => ({
	handleCurateCommand: mock(),
}));
mock.module('../../src/commands/write_retro.js', () => ({
	handleWriteRetroCommand: mock(),
}));
mock.module('../../src/commands/checkpoint.js', () => ({
	handleCheckpointCommand: mock(),
}));

import {
	COMMAND_REGISTRY,
	resolveCommand,
	VALID_COMMANDS,
} from '../../src/commands/registry.js';

describe('COMMAND_REGISTRY', () => {
	describe('1. Registry coverage — keys and VALID_COMMANDS are in sync', () => {
		it('every key in COMMAND_REGISTRY appears in VALID_COMMANDS', () => {
			const registryKeys = Object.keys(COMMAND_REGISTRY);
			for (const key of registryKeys) {
				expect(VALID_COMMANDS).toContain(key);
			}
		});

		it('every entry in VALID_COMMANDS appears in COMMAND_REGISTRY', () => {
			for (const cmd of VALID_COMMANDS) {
				expect(COMMAND_REGISTRY).toHaveProperty(cmd);
			}
		});

		it('VALID_COMMANDS length matches COMMAND_REGISTRY key count', () => {
			expect(VALID_COMMANDS.length).toBe(Object.keys(COMMAND_REGISTRY).length);
		});
	});

	describe('2. All valid commands resolve non-null via resolveCommand', () => {
		for (const cmd of Object.keys(COMMAND_REGISTRY)) {
			it(`resolveCommand(['${cmd}']) is non-null`, () => {
				// Split compound keys into tokens (e.g. "evidence summary" → ["evidence", "summary"])
				const tokens = cmd.split(' ');
				const result = resolveCommand(tokens);
				expect(result).not.toBeNull();
			});
		}
	});
});

describe('resolveCommand()', () => {
	describe('3. Compound command resolution', () => {
		it('["evidence", "summary"] resolves to the "evidence summary" entry, not bare "evidence"', () => {
			const result = resolveCommand(['evidence', 'summary']);
			expect(result).not.toBeNull();
			// The resolved entry description should match "evidence summary", not plain "evidence"
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['evidence summary'].description,
			);
			expect(result!.entry.description).not.toBe(
				COMMAND_REGISTRY['evidence'].description,
			);
			expect(result!.remainingArgs).toEqual([]);
		});

		it('["config", "doctor"] resolves to the "config doctor" entry, not bare "config"', () => {
			const result = resolveCommand(['config', 'doctor']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['config doctor'].description,
			);
			expect(result!.entry.description).not.toBe(
				COMMAND_REGISTRY['config'].description,
			);
			expect(result!.remainingArgs).toEqual([]);
		});

		it('["knowledge", "migrate"] resolves to "knowledge migrate", not bare "knowledge"', () => {
			const result = resolveCommand(['knowledge', 'migrate']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['knowledge migrate'].description,
			);
			expect(result!.remainingArgs).toEqual([]);
		});

		it('compound resolution passes remaining args correctly', () => {
			const result = resolveCommand([
				'evidence',
				'summary',
				'--verbose',
				'--json',
			]);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['evidence summary'].description,
			);
			expect(result!.remainingArgs).toEqual(['--verbose', '--json']);
		});
	});

	describe('4. Single-token resolution falls back when compound does not match', () => {
		it('["evidence", "list"] resolves to bare "evidence" (not a compound key)', () => {
			const result = resolveCommand(['evidence', 'list']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['evidence'].description,
			);
			expect(result!.remainingArgs).toEqual(['list']);
		});

		it('["knowledge"] resolves to bare "knowledge"', () => {
			const result = resolveCommand(['knowledge']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['knowledge'].description,
			);
			expect(result!.remainingArgs).toEqual([]);
		});

		it('single-token resolution passes remaining args correctly', () => {
			const result = resolveCommand(['diagnose', '--verbose']);
			expect(result).not.toBeNull();
			expect(result!.entry.description).toBe(
				COMMAND_REGISTRY['diagnose'].description,
			);
			expect(result!.remainingArgs).toEqual(['--verbose']);
		});
	});

	describe('5. Unknown command returns null', () => {
		it('resolveCommand(["foobar"]) returns null', () => {
			expect(resolveCommand(['foobar'])).toBeNull();
		});

		it('resolveCommand([]) returns null', () => {
			expect(resolveCommand([])).toBeNull();
		});

		it('resolveCommand(["unknown", "subcommand"]) returns null when neither compound nor single key exists', () => {
			expect(resolveCommand(['unknown', 'subcommand'])).toBeNull();
		});

		it('resolveCommand(["evidence", "summary"]) does NOT return null (sanity)', () => {
			expect(resolveCommand(['evidence', 'summary'])).not.toBeNull();
		});
	});
});
