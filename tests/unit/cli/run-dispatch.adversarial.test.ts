import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';

// Mock console methods BEFORE importing
const mockConsoleLog = spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = spyOn(console, 'error').mockImplementation(() => {});

// Mock process.argv to prevent default 'install' command
const originalArgv = process.argv;
process.argv = ['node', 'cli.js', '--help'];

// Mock process.exit to prevent CLI from exiting
const mockProcessExit = spyOn(process, 'exit').mockImplementation(
	() => undefined as never,
);

// Mock factories - declare BEFORE mock.module() calls
const mockHandleStatusCommand = mock();
const mockHandlePlanCommand = mock();
const mockHandleAgentsCommand = mock();
const mockHandleArchiveCommand = mock();
const mockHandleHistoryCommand = mock();
const mockHandleConfigCommand = mock();
const mockHandleDoctorCommand = mock();
const mockHandleEvidenceCommand = mock();
const mockHandleEvidenceSummaryCommand = mock();
const mockHandleDiagnoseCommand = mock();
const mockHandlePreflightCommand = mock();
const mockHandleSyncPlanCommand = mock();
const mockHandleBenchmarkCommand = mock();
const mockHandleExportCommand = mock();
const mockHandleResetCommand = mock();
const mockHandleRetrieveCommand = mock();
const mockHandleClarifyCommand = mock();
const mockHandleAnalyzeCommand = mock();
const mockHandleSpecifyCommand = mock();
const mockHandleDarkMatterCommand = mock();
const mockHandleKnowledgeListCommand = mock();
const mockHandleKnowledgeMigrateCommand = mock();
const mockHandleKnowledgeQuarantineCommand = mock();
const mockHandleKnowledgeRestoreCommand = mock();
const mockHandleRollbackCommand = mock();
const mockHandlePromoteCommand = mock();
const mockHandleHandoffCommand = mock();
const mockHandleTurboCommand = mock();
const mockHandleSimulateCommand = mock();
const mockHandleCurateCommand = mock();
const mockHandleWriteRetroCommand = mock();
const mockHandleCheckpointCommand = mock();
const mockHandleDoctorToolsCommand = mock();

// Mock individual command files so registry.ts picks up the mocked handlers
mock.module('../../../src/commands/status.js', () => ({
	handleStatusCommand: mockHandleStatusCommand,
}));
mock.module('../../../src/commands/plan.js', () => ({
	handlePlanCommand: mockHandlePlanCommand,
}));
mock.module('../../../src/commands/agents.js', () => ({
	handleAgentsCommand: mockHandleAgentsCommand,
}));
mock.module('../../../src/commands/archive.js', () => ({
	handleArchiveCommand: mockHandleArchiveCommand,
}));
mock.module('../../../src/commands/history.js', () => ({
	handleHistoryCommand: mockHandleHistoryCommand,
}));
mock.module('../../../src/commands/config.js', () => ({
	handleConfigCommand: mockHandleConfigCommand,
}));
mock.module('../../../src/commands/doctor.js', () => ({
	handleDoctorCommand: mockHandleDoctorCommand,
	handleDoctorToolsCommand: mockHandleDoctorToolsCommand,
}));
mock.module('../../../src/commands/evidence.js', () => ({
	handleEvidenceCommand: mockHandleEvidenceCommand,
	handleEvidenceSummaryCommand: mockHandleEvidenceSummaryCommand,
}));
mock.module('../../../src/commands/diagnose.js', () => ({
	handleDiagnoseCommand: mockHandleDiagnoseCommand,
}));
mock.module('../../../src/commands/preflight.js', () => ({
	handlePreflightCommand: mockHandlePreflightCommand,
}));
mock.module('../../../src/commands/sync-plan.js', () => ({
	handleSyncPlanCommand: mockHandleSyncPlanCommand,
}));
mock.module('../../../src/commands/benchmark.js', () => ({
	handleBenchmarkCommand: mockHandleBenchmarkCommand,
}));
mock.module('../../../src/commands/export.js', () => ({
	handleExportCommand: mockHandleExportCommand,
}));
mock.module('../../../src/commands/reset.js', () => ({
	handleResetCommand: mockHandleResetCommand,
}));
mock.module('../../../src/commands/retrieve.js', () => ({
	handleRetrieveCommand: mockHandleRetrieveCommand,
}));
mock.module('../../../src/commands/clarify.js', () => ({
	handleClarifyCommand: mockHandleClarifyCommand,
}));
mock.module('../../../src/commands/analyze.js', () => ({
	handleAnalyzeCommand: mockHandleAnalyzeCommand,
}));
mock.module('../../../src/commands/specify.js', () => ({
	handleSpecifyCommand: mockHandleSpecifyCommand,
}));
mock.module('../../../src/commands/dark-matter.js', () => ({
	handleDarkMatterCommand: mockHandleDarkMatterCommand,
}));
mock.module('../../../src/commands/knowledge.js', () => ({
	handleKnowledgeListCommand: mockHandleKnowledgeListCommand,
	handleKnowledgeMigrateCommand: mockHandleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand: mockHandleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand: mockHandleKnowledgeRestoreCommand,
	handleKnowledgeUnactionableCommand: () => null,
	handleKnowledgeRetryHardeningCommand: () => null,
}));
mock.module('../../../src/commands/rollback.js', () => ({
	handleRollbackCommand: mockHandleRollbackCommand,
}));
mock.module('../../../src/commands/promote.js', () => ({
	handlePromoteCommand: mockHandlePromoteCommand,
}));
mock.module('../../../src/commands/handoff.js', () => ({
	handleHandoffCommand: mockHandleHandoffCommand,
}));
mock.module('../../../src/commands/turbo.js', () => ({
	handleTurboCommand: mockHandleTurboCommand,
}));
mock.module('../../../src/commands/simulate.js', () => ({
	handleSimulateCommand: mockHandleSimulateCommand,
}));
mock.module('../../../src/commands/curate.js', () => ({
	handleCurateCommand: mockHandleCurateCommand,
}));
mock.module('../../../src/commands/write_retro.js', () => ({
	handleWriteRetroCommand: mockHandleWriteRetroCommand,
}));
mock.module('../../../src/commands/checkpoint.js', () => ({
	handleCheckpointCommand: mockHandleCheckpointCommand,
}));

// Import AFTER mocking is set up - use require for synchronous loading
// @ts-ignore - Bun supports require for .js extensions
const cliModule = require('../../../src/cli/index.js');
const run = cliModule.run;

describe('run() dispatch function - ADVERSARIAL SECURITY & BOUNDARY TESTS', () => {
	const cwd = process.cwd();

	beforeEach(() => {
		mockConsoleLog.mockClear();
		mockConsoleError.mockClear();
		mockProcessExit.mockClear();
		// Clear all handler mocks to reset call history
		mockHandleStatusCommand.mockClear();
		mockHandlePlanCommand.mockClear();
		mockHandleAgentsCommand.mockClear();
		mockHandleArchiveCommand.mockClear();
		mockHandleHistoryCommand.mockClear();
		mockHandleConfigCommand.mockClear();
		mockHandleDoctorCommand.mockClear();
		mockHandleEvidenceCommand.mockClear();
		mockHandleEvidenceSummaryCommand.mockClear();
		mockHandleDiagnoseCommand.mockClear();
		mockHandlePreflightCommand.mockClear();
		mockHandleSyncPlanCommand.mockClear();
		mockHandleBenchmarkCommand.mockClear();
		mockHandleExportCommand.mockClear();
		mockHandleResetCommand.mockClear();
		mockHandleRetrieveCommand.mockClear();
		mockHandleClarifyCommand.mockClear();
		mockHandleAnalyzeCommand.mockClear();
		mockHandleSpecifyCommand.mockClear();
		mockHandleDarkMatterCommand.mockClear();
		mockHandleKnowledgeListCommand.mockClear();
		mockHandleKnowledgeMigrateCommand.mockClear();
		mockHandleKnowledgeQuarantineCommand.mockClear();
		mockHandleKnowledgeRestoreCommand.mockClear();
		mockHandleHandoffCommand.mockClear();
		mockHandleTurboCommand.mockClear();
		mockHandleCheckpointCommand.mockClear();
		// Default return values for mocked handlers
		mockHandleStatusCommand.mockResolvedValue('status output');
		mockHandlePlanCommand.mockResolvedValue('plan output');
		mockHandleAgentsCommand.mockReturnValue('agents output');
		mockHandleArchiveCommand.mockResolvedValue('archive output');
		mockHandleHistoryCommand.mockResolvedValue('history output');
		mockHandleConfigCommand.mockResolvedValue('config output');
		mockHandleDoctorCommand.mockResolvedValue('doctor output');
		mockHandleEvidenceCommand.mockResolvedValue('evidence output');
		mockHandleEvidenceSummaryCommand.mockResolvedValue(
			'evidence summary output',
		);
		mockHandleDiagnoseCommand.mockResolvedValue('diagnose output');
		mockHandlePreflightCommand.mockResolvedValue('preflight output');
		mockHandleSyncPlanCommand.mockResolvedValue('sync-plan output');
		mockHandleBenchmarkCommand.mockResolvedValue('benchmark output');
		mockHandleExportCommand.mockResolvedValue('export output');
		mockHandleResetCommand.mockResolvedValue('reset output');
		mockHandleRetrieveCommand.mockResolvedValue('retrieve output');
		mockHandleClarifyCommand.mockResolvedValue('clarify output');
		mockHandleAnalyzeCommand.mockResolvedValue('analyze output');
		mockHandleSpecifyCommand.mockResolvedValue('specify output');
		mockHandleDarkMatterCommand.mockResolvedValue('dark-matter output');
		mockHandleKnowledgeListCommand.mockResolvedValue('knowledge list output');
		mockHandleKnowledgeMigrateCommand.mockResolvedValue(
			'knowledge migrate output',
		);
		mockHandleKnowledgeQuarantineCommand.mockResolvedValue(
			'knowledge quarantine output',
		);
		mockHandleKnowledgeRestoreCommand.mockResolvedValue(
			'knowledge restore output',
		);
		mockHandleHandoffCommand.mockResolvedValue('handoff output');
		mockHandleTurboCommand.mockResolvedValue('turbo output');
		mockHandleCheckpointCommand.mockResolvedValue('checkpoint output');
	});

	describe('1. Null/undefined input attacks', () => {
		it('should handle null instead of array gracefully', async () => {
			// @ts-expect-error - Testing with null (type violation)
			const result = await run(null);

			// Should treat null as falsy and return usage error
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: bunx opencode-swarm run <command>'),
			);
		});

		it('should handle undefined instead of array gracefully', async () => {
			// @ts-expect-error - Testing with undefined (type violation)
			const result = await run(undefined);

			// Should treat undefined as falsy and return usage error
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: bunx opencode-swarm run <command>'),
			);
		});
	});

	describe('2. Empty/whitespace input attacks', () => {
		it('should handle empty string subcommand', async () => {
			const result = await run(['']);

			// Should treat empty string as unknown command
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: '),
			);
		});

		it('should handle whitespace-only subcommand', async () => {
			const result = await run(['   ']);

			// Should treat whitespace as unknown command
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:    '),
			);
		});
	});

	describe('3. Null byte injection attacks', () => {
		it('should handle null byte in command name', async () => {
			const result = await run(['\x00']);

			// Should handle null byte gracefully, not crash
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: \x00'),
			);
		});

		it('should handle command with embedded null bytes', async () => {
			const result = await run(['status\x00evil']);

			// Should handle embedded null bytes gracefully
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});
	});

	describe('4. Knowledge sub-subcommand boundary violations', () => {
		it('should handle knowledge with no sub-subcommand (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge']);

			// Registry falls through to knowledge list entry
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, []);
		});

		it('should handle knowledge with empty sub-subcommand (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge', '']);

			// Compound key 'knowledge ' not in registry → falls to 'knowledge'
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, ['']);
		});

		it('should handle knowledge with unknown sub-subcommand (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge', 'unknown-sub']);

			// Compound key 'knowledge unknown-sub' not in registry → falls to 'knowledge'
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, [
				'unknown-sub',
			]);
		});

		it('should handle knowledge with whitespace sub-subcommand (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge', '   ']);

			// Falls through to knowledge list
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, ['   ']);
		});

		it('should handle knowledge with case-sensitive mismatch (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge', 'MIGRATE']);

			// 'knowledge MIGRATE' not in registry → falls to 'knowledge'
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, [
				'MIGRATE',
			]);
		});
	});

	describe('5. Config subcommand boundary violations', () => {
		it('should handle config with no sub-subcommand (calls handleConfigCommand)', async () => {
			const result = await run(['config']);

			// Should call handleConfigCommand, not crash
			expect(result).toBe(0);
			expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		});

		it('should handle config with empty sub-subcommand', async () => {
			const result = await run(['config', '']);

			// Should call handleConfigCommand with empty string, not crash
			expect(result).toBe(0);
			expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, ['']);
			expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		});

		it('should handle config with unknown sub-subcommand', async () => {
			const result = await run(['config', 'unknown']);

			// Should call handleConfigCommand with unknown sub-subcommand, not crash
			expect(result).toBe(0);
			expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, ['unknown']);
			expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		});
	});

	describe('6. Evidence subcommand boundary violations', () => {
		it('should handle evidence with no sub-subcommand (calls handleEvidenceCommand)', async () => {
			const result = await run(['evidence']);

			// Should call handleEvidenceCommand, not crash
			expect(result).toBe(0);
			expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
		});

		it('should handle evidence with empty sub-subcommand', async () => {
			const result = await run(['evidence', '']);

			// Should call handleEvidenceCommand with empty string, not crash
			expect(result).toBe(0);
			expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, ['']);
			expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
		});

		it('should handle evidence with unknown sub-subcommand', async () => {
			const result = await run(['evidence', 'unknown']);

			// Should call handleEvidenceCommand with unknown sub-subcommand, not crash
			expect(result).toBe(0);
			expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, ['unknown']);
			expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
		});
	});

	describe('7. Oversized payload attacks', () => {
		it('should handle very long command name (1000 chars)', async () => {
			const longCommand = Array(1000).fill('a').join('');
			const result = await run([longCommand]);

			// Should handle long command name gracefully, not crash
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});

		it('should handle extremely long command name (10000 chars)', async () => {
			const longCommand = Array(10000).fill('b').join('');
			const result = await run([longCommand]);

			// Should handle extremely long command name gracefully, not crash
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});

		it('should handle very long args array', async () => {
			const longArgs = Array(1000).fill('arg').join(' ').split(' ');
			const result = await run(longArgs);

			// Should handle long args array gracefully, not crash
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});
	});

	describe('8. Special character injection attacks', () => {
		it('should handle command with control characters', async () => {
			const result = await run(['\n\r\t']);

			// Should handle control characters gracefully
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});

		it('should handle command with unicode surrogate pairs', async () => {
			const result = await run(['status\uD83D\uDE00']);

			// Should handle unicode gracefully (may or may not be valid command)
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command:'),
			);
		});

		it('should handle command with path traversal pattern', async () => {
			const result = await run(['../../etc/passwd']);

			// Should treat as unknown command, not execute path traversal
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: ../../etc/passwd'),
			);
		});

		it('should handle command with shell metacharacters', async () => {
			const result = await run(['status; rm -rf /']);

			// Should treat as unknown command, not execute shell injection
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: status; rm -rf /'),
			);
		});

		it('should handle command with command substitution', async () => {
			const result = await run(['$(whoami)']);

			// Should treat as unknown command, not execute command substitution
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: $(whoami)'),
			);
		});
	});

	describe('9. Type coercion attacks', () => {
		it('should handle numeric command', async () => {
			// @ts-expect-error - Testing with numeric (type violation)
			const result = await run([123]);

			// Should handle numeric command (coerced to string)
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: 123'),
			);
		});

		it('should handle boolean command', async () => {
			// @ts-expect-error - Testing with boolean (type violation)
			const result = await run([true]);

			// Should handle boolean command (coerced to string)
			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: true'),
			);
		});
	});

	describe('10. Malformed multi-word command attacks', () => {
		it('should handle knowledge with null byte in sub-subcommand (calls handleKnowledgeListCommand)', async () => {
			const result = await run(['knowledge', '\x00']);

			// 'knowledge \x00' not in registry → falls to 'knowledge'
			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, [
				'\x00',
			]);
		});

		it('should handle config doctor with very long subcommand', async () => {
			const longSubcmd = Array(1000).fill('x').join('');
			const result = await run(['config', 'doctor', longSubcmd]);

			// Should pass long subcommand to handler, not crash
			expect(result).toBe(0);
			expect(mockHandleDoctorCommand).toHaveBeenCalledWith(cwd, [longSubcmd]);
		});

		it('should handle evidence summary with additional unexpected args', async () => {
			const result = await run(['evidence', 'summary', 'unexpected', 'args']);

			// Should ignore unexpected args for summary, not crash
			expect(result).toBe(0);
			expect(mockHandleEvidenceSummaryCommand).toHaveBeenCalledWith(cwd);
		});
	});
});
