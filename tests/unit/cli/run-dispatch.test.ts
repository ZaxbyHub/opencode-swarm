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

describe('run() dispatch function', () => {
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

	describe('1. Empty args', () => {
		it('should return 1 for empty args array', async () => {
			const result = await run([]);

			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Usage: bunx opencode-swarm run <command>'),
			);
		});
	});

	describe('2. Unknown command', () => {
		it('should return 1 for unknown command', async () => {
			const result = await run(['unknown-xyz']);

			expect(result).toBe(1);
			expect(mockConsoleError).toHaveBeenCalledWith(
				expect.stringContaining('Unknown command: unknown-xyz'),
			);
		});
	});

	describe('3. Single-word commands', () => {
		it('dark-matter: calls handleDarkMatterCommand with cwd and empty args', async () => {
			const result = await run(['dark-matter']);

			expect(result).toBe(0);
			expect(mockHandleDarkMatterCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('dark-matter output');
		});

		it('status: calls handleStatusCommand with cwd and empty agents', async () => {
			const result = await run(['status']);

			expect(result).toBe(0);
			expect(mockHandleStatusCommand).toHaveBeenCalledWith(cwd, {});
			expect(mockConsoleLog).toHaveBeenCalledWith('status output');
		});

		it('plan: calls handlePlanCommand with cwd and empty args', async () => {
			const result = await run(['plan']);

			expect(result).toBe(0);
			expect(mockHandlePlanCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('plan output');
		});

		it('archive: calls handleArchiveCommand with cwd and empty args', async () => {
			const result = await run(['archive']);

			expect(result).toBe(0);
			expect(mockHandleArchiveCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('archive output');
		});

		it('history: calls handleHistoryCommand with cwd and empty args', async () => {
			const result = await run(['history']);

			expect(result).toBe(0);
			expect(mockHandleHistoryCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('history output');
		});
	});

	describe('4. agents command (sync, no directory)', () => {
		it('agents: calls handleAgentsCommand with {} and undefined (sync)', async () => {
			const result = await run(['agents']);

			expect(result).toBe(0);
			expect(mockHandleAgentsCommand).toHaveBeenCalledWith({}, undefined);
			expect(mockConsoleLog).toHaveBeenCalledWith('agents output');
		});
	});

	describe('5. Multi-word dispatch: config', () => {
		it('config doctor: calls handleDoctorCommand (not handleConfigCommand)', async () => {
			const result = await run(['config', 'doctor']);

			expect(result).toBe(0);
			expect(mockHandleDoctorCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockHandleConfigCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('doctor output');
		});

		it('config: calls handleConfigCommand with args.slice(1)', async () => {
			const result = await run(['config']);

			expect(result).toBe(0);
			expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('config output');
		});

		it('config with subcommand (non-doctor): calls handleConfigCommand', async () => {
			const result = await run(['config', 'some-other-subcmd']);

			expect(result).toBe(0);
			expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, [
				'some-other-subcmd',
			]);
			expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('config output');
		});

		it('config doctor with additional args: passes args.slice(2)', async () => {
			const result = await run(['config', 'doctor', '--verbose']);

			expect(result).toBe(0);
			expect(mockHandleDoctorCommand).toHaveBeenCalledWith(cwd, ['--verbose']);
			expect(mockConsoleLog).toHaveBeenCalledWith('doctor output');
		});
	});

	describe('6. Multi-word dispatch: evidence', () => {
		it('evidence summary: calls handleEvidenceSummaryCommand (not handleEvidenceCommand)', async () => {
			const result = await run(['evidence', 'summary']);

			expect(result).toBe(0);
			expect(mockHandleEvidenceSummaryCommand).toHaveBeenCalledWith(cwd);
			expect(mockHandleEvidenceCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('evidence summary output');
		});

		it('evidence: calls handleEvidenceCommand with args.slice(1)', async () => {
			const result = await run(['evidence']);

			expect(result).toBe(0);
			expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('evidence output');
		});

		it('evidence with subcommand (non-summary): calls handleEvidenceCommand', async () => {
			const result = await run(['evidence', 'list']);

			expect(result).toBe(0);
			expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, ['list']);
			expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
			expect(mockConsoleLog).toHaveBeenCalledWith('evidence output');
		});
	});

	describe('7. Multi-word dispatch: knowledge', () => {
		it('knowledge migrate: calls handleKnowledgeMigrateCommand with cwd and args.slice(2)', async () => {
			const result = await run(['knowledge', 'migrate']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('knowledge migrate output');
		});

		it('knowledge quarantine: calls handleKnowledgeQuarantineCommand', async () => {
			const result = await run(['knowledge', 'quarantine']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeQuarantineCommand).toHaveBeenCalledWith(
				cwd,
				[],
			);
			expect(mockConsoleLog).toHaveBeenCalledWith(
				'knowledge quarantine output',
			);
		});

		it('knowledge restore: calls handleKnowledgeRestoreCommand', async () => {
			const result = await run(['knowledge', 'restore']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeRestoreCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('knowledge restore output');
		});

		it('knowledge with unknown subcommand: calls handleKnowledgeListCommand (consistent with hook)', async () => {
			const result = await run(['knowledge', 'unknown']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, [
				'unknown',
			]);
			expect(mockConsoleLog).toHaveBeenCalledWith('knowledge list output');
		});

		it('knowledge with no subcommand: calls handleKnowledgeListCommand', async () => {
			const result = await run(['knowledge']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('knowledge list output');
		});

		it('knowledge migrate with additional args: passes args.slice(2)', async () => {
			const result = await run(['knowledge', 'migrate', '--verbose']);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(cwd, [
				'--verbose',
			]);
			expect(mockConsoleLog).toHaveBeenCalledWith('knowledge migrate output');
		});
	});

	describe('8. Other single-word commands', () => {
		it('diagnose: calls handleDiagnoseCommand', async () => {
			const result = await run(['diagnose']);

			expect(result).toBe(0);
			expect(mockHandleDiagnoseCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('diagnose output');
		});

		it('preflight: calls handlePreflightCommand', async () => {
			const result = await run(['preflight']);

			expect(result).toBe(0);
			expect(mockHandlePreflightCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('preflight output');
		});

		it('sync-plan: calls handleSyncPlanCommand', async () => {
			const result = await run(['sync-plan']);

			expect(result).toBe(0);
			expect(mockHandleSyncPlanCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('sync-plan output');
		});

		it('benchmark: calls handleBenchmarkCommand', async () => {
			const result = await run(['benchmark']);

			expect(result).toBe(0);
			expect(mockHandleBenchmarkCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('benchmark output');
		});

		it('export: calls handleExportCommand', async () => {
			const result = await run(['export']);

			expect(result).toBe(0);
			expect(mockHandleExportCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('export output');
		});

		it('reset: calls handleResetCommand', async () => {
			const result = await run(['reset']);

			expect(result).toBe(0);
			expect(mockHandleResetCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('reset output');
		});

		it('retrieve: calls handleRetrieveCommand', async () => {
			const result = await run(['retrieve']);

			expect(result).toBe(0);
			expect(mockHandleRetrieveCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('retrieve output');
		});

		it('clarify: calls handleClarifyCommand', async () => {
			const result = await run(['clarify']);

			expect(result).toBe(0);
			expect(mockHandleClarifyCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('clarify output');
		});

		it('analyze: calls handleAnalyzeCommand', async () => {
			const result = await run(['analyze']);

			expect(result).toBe(0);
			expect(mockHandleAnalyzeCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('analyze output');
		});

		it('specify: calls handleSpecifyCommand', async () => {
			const result = await run(['specify']);

			expect(result).toBe(0);
			expect(mockHandleSpecifyCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('specify output');
		});

		it('checkpoint: calls handleCheckpointCommand', async () => {
			const result = await run(['checkpoint']);

			expect(result).toBe(0);
			expect(mockHandleCheckpointCommand).toHaveBeenCalledWith(cwd, []);
			expect(mockConsoleLog).toHaveBeenCalledWith('checkpoint output');
		});
	});

	describe('9. Args propagation', () => {
		it('passes args.slice(1) to single-word commands', async () => {
			const result = await run([
				'dark-matter',
				'--verbose',
				'--output',
				'file.json',
			]);

			expect(result).toBe(0);
			expect(mockHandleDarkMatterCommand).toHaveBeenCalledWith(cwd, [
				'--verbose',
				'--output',
				'file.json',
			]);
		});

		it('passes args.slice(2) to multi-word commands (knowledge)', async () => {
			const result = await run([
				'knowledge',
				'migrate',
				'--verbose',
				'--dry-run',
			]);

			expect(result).toBe(0);
			expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(cwd, [
				'--verbose',
				'--dry-run',
			]);
		});

		it('passes args.slice(2) to multi-word commands (config doctor)', async () => {
			const result = await run(['config', 'doctor', '--fix', '--verbose']);

			expect(result).toBe(0);
			expect(mockHandleDoctorCommand).toHaveBeenCalledWith(cwd, [
				'--fix',
				'--verbose',
			]);
		});
	});
});
