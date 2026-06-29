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
const mockHandleAgentsCommand = mock();
const mockHandleAnalyzeCommand = mock();
const mockHandleArchiveCommand = mock();
const mockHandleBenchmarkCommand = mock();
const mockHandleCheckpointCommand = mock();
const mockHandleClarifyCommand = mock();
const mockHandleConfigCommand = mock();
const mockHandleCurateCommand = mock();
const mockHandleDarkMatterCommand = mock();
const mockHandleDiagnoseCommand = mock();
const mockHandleDoctorCommand = mock();
const mockHandleEvidenceCommand = mock();
const mockHandleEvidenceSummaryCommand = mock();
const mockHandleExportCommand = mock();
const mockHandleHandoffCommand = mock();
const mockHandleHistoryCommand = mock();
const mockHandleKnowledgeListCommand = mock();
const mockHandleKnowledgeMigrateCommand = mock();
const mockHandleKnowledgeQuarantineCommand = mock();
const mockHandleKnowledgeRestoreCommand = mock();
const mockHandlePlanCommand = mock();
const mockHandlePreflightCommand = mock();
const mockHandlePromoteCommand = mock();
const mockHandleResetCommand = mock();
const mockHandleRetrieveCommand = mock();
const mockHandleRollbackCommand = mock();
const mockHandleSimulateCommand = mock();
const mockHandleSpecifyCommand = mock();
const mockHandleStatusCommand = mock();
const mockHandleSyncPlanCommand = mock();
const mockHandleTurboCommand = mock();
const mockHandleWriteRetroCommand = mock();
const mockHandleDoctorToolsCommand = mock();

// Mock individual command files so registry.ts picks up the mocked handlers
mock.module('../../../src/commands/agents.js', () => ({
	handleAgentsCommand: mockHandleAgentsCommand,
}));
mock.module('../../../src/commands/analyze.js', () => ({
	handleAnalyzeCommand: mockHandleAnalyzeCommand,
}));
mock.module('../../../src/commands/archive.js', () => ({
	handleArchiveCommand: mockHandleArchiveCommand,
}));
mock.module('../../../src/commands/benchmark.js', () => ({
	handleBenchmarkCommand: mockHandleBenchmarkCommand,
}));
mock.module('../../../src/commands/checkpoint.js', () => ({
	handleCheckpointCommand: mockHandleCheckpointCommand,
}));
mock.module('../../../src/commands/clarify.js', () => ({
	handleClarifyCommand: mockHandleClarifyCommand,
}));
mock.module('../../../src/commands/config.js', () => ({
	handleConfigCommand: mockHandleConfigCommand,
}));
mock.module('../../../src/commands/curate.js', () => ({
	handleCurateCommand: mockHandleCurateCommand,
}));
mock.module('../../../src/commands/dark-matter.js', () => ({
	handleDarkMatterCommand: mockHandleDarkMatterCommand,
}));
mock.module('../../../src/commands/diagnose.js', () => ({
	handleDiagnoseCommand: mockHandleDiagnoseCommand,
}));
mock.module('../../../src/commands/doctor.js', () => ({
	handleDoctorCommand: mockHandleDoctorCommand,
	handleDoctorToolsCommand: mockHandleDoctorToolsCommand,
}));
mock.module('../../../src/commands/evidence.js', () => ({
	handleEvidenceCommand: mockHandleEvidenceCommand,
	handleEvidenceSummaryCommand: mockHandleEvidenceSummaryCommand,
}));
mock.module('../../../src/commands/export.js', () => ({
	handleExportCommand: mockHandleExportCommand,
}));
mock.module('../../../src/commands/handoff.js', () => ({
	handleHandoffCommand: mockHandleHandoffCommand,
}));
mock.module('../../../src/commands/history.js', () => ({
	handleHistoryCommand: mockHandleHistoryCommand,
}));
mock.module('../../../src/commands/knowledge.js', () => ({
	handleKnowledgeListCommand: mockHandleKnowledgeListCommand,
	handleKnowledgeMigrateCommand: mockHandleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand: mockHandleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand: mockHandleKnowledgeRestoreCommand,
	handleKnowledgeUnactionableCommand: () => null,
	handleKnowledgeRetryHardeningCommand: () => null,
}));
mock.module('../../../src/commands/plan.js', () => ({
	handlePlanCommand: mockHandlePlanCommand,
}));
mock.module('../../../src/commands/preflight.js', () => ({
	handlePreflightCommand: mockHandlePreflightCommand,
}));
mock.module('../../../src/commands/promote.js', () => ({
	handlePromoteCommand: mockHandlePromoteCommand,
}));
mock.module('../../../src/commands/reset.js', () => ({
	handleResetCommand: mockHandleResetCommand,
}));
mock.module('../../../src/commands/retrieve.js', () => ({
	handleRetrieveCommand: mockHandleRetrieveCommand,
}));
mock.module('../../../src/commands/rollback.js', () => ({
	handleRollbackCommand: mockHandleRollbackCommand,
}));
mock.module('../../../src/commands/simulate.js', () => ({
	handleSimulateCommand: mockHandleSimulateCommand,
}));
mock.module('../../../src/commands/specify.js', () => ({
	handleSpecifyCommand: mockHandleSpecifyCommand,
}));
mock.module('../../../src/commands/status.js', () => ({
	handleStatusCommand: mockHandleStatusCommand,
}));
mock.module('../../../src/commands/sync-plan.js', () => ({
	handleSyncPlanCommand: mockHandleSyncPlanCommand,
}));
mock.module('../../../src/commands/turbo.js', () => ({
	handleTurboCommand: mockHandleTurboCommand,
}));
mock.module('../../../src/commands/write_retro.js', () => ({
	handleWriteRetroCommand: mockHandleWriteRetroCommand,
}));

// Import AFTER mocking is set up - use require for synchronous loading
// @ts-ignore - Bun supports require for .js extensions
const cliModule = require('../../../src/cli/index.js');
const run = cliModule.run;

describe('run() function - Adversarial Tests', () => {
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
		mockHandleWriteRetroCommand.mockClear();
		// Default return values for mocked handlers
		mockHandleStatusCommand.mockResolvedValue('status result');
		mockHandlePlanCommand.mockResolvedValue('plan result');
		mockHandleAgentsCommand.mockReturnValue('agents result');
		mockHandleArchiveCommand.mockResolvedValue('archive result');
		mockHandleHistoryCommand.mockResolvedValue('history result');
		mockHandleConfigCommand.mockResolvedValue('config result');
		mockHandleDoctorCommand.mockResolvedValue('doctor result');
		mockHandleEvidenceCommand.mockResolvedValue('evidence result');
		mockHandleEvidenceSummaryCommand.mockResolvedValue(
			'evidence-summary result',
		);
		mockHandleDiagnoseCommand.mockResolvedValue('diagnose result');
		mockHandlePreflightCommand.mockResolvedValue('preflight result');
		mockHandleSyncPlanCommand.mockResolvedValue('sync-plan result');
		mockHandleBenchmarkCommand.mockResolvedValue('benchmark result');
		mockHandleExportCommand.mockResolvedValue('export result');
		mockHandleResetCommand.mockResolvedValue('reset result');
		mockHandleRetrieveCommand.mockResolvedValue('retrieve result');
		mockHandleClarifyCommand.mockResolvedValue('clarify result');
		mockHandleAnalyzeCommand.mockResolvedValue('analyze result');
		mockHandleSpecifyCommand.mockResolvedValue('specify result');
		mockHandleDarkMatterCommand.mockResolvedValue('dark-matter result');
		mockHandleKnowledgeListCommand.mockResolvedValue('knowledge list result');
		mockHandleKnowledgeMigrateCommand.mockResolvedValue(
			'knowledge migrate result',
		);
		mockHandleKnowledgeQuarantineCommand.mockResolvedValue(
			'knowledge quarantine result',
		);
		mockHandleKnowledgeRestoreCommand.mockResolvedValue(
			'knowledge restore result',
		);
	});

	// Attack vector 1: Handler throws an error → does run() propagate the throw, or handle gracefully?
	it('1. Should propagate error when handler throws', async () => {
		const mockError = new Error('Handler error');
		mockHandleStatusCommand.mockRejectedValueOnce(mockError);

		await expect(run(['status'])).rejects.toThrow('Handler error');

		// Verify console.log was not called for the result
		expect(mockConsoleLog).not.toHaveBeenCalled();
	});

	// Attack vector 2: Handler returns null instead of string → console.log(null) called, returns 0
	it('2. Should call console.log(null) when handler returns null', async () => {
		mockHandleStatusCommand.mockResolvedValueOnce(null as unknown as string);

		const result = await run(['status']);

		expect(result).toBe(0);
		expect(mockConsoleLog).toHaveBeenCalledWith(null);
	});

	// Attack vector 3: Handler returns undefined → console.log(undefined), returns 0
	it('3. Should call console.log(undefined) when handler returns undefined', async () => {
		mockHandleStatusCommand.mockResolvedValueOnce(
			undefined as unknown as string,
		);

		const result = await run(['status']);

		expect(result).toBe(0);
		expect(mockConsoleLog).toHaveBeenCalledWith(undefined);
	});

	// Attack vector 4: 'knowledge' with no subcommand → falls through to handleKnowledgeListCommand, returns 0
	it('4. Should return 0 for "knowledge" with no subcommand (calls handleKnowledgeListCommand)', async () => {
		const result = await run(['knowledge']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, []);
		expect(mockConsoleLog).toHaveBeenCalledWith('knowledge list result');
	});

	// Attack vector 5: Args array with only whitespace string: `[' ']` → hits unknown command default, returns 1
	it('5. Should return 1 for args with only whitespace string', async () => {
		const result = await run([' ']);

		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command:  '),
		);
	});

	// Attack vector 6: 'knowledge' with only 1 element → falls through to handleKnowledgeListCommand, returns 0
	it('6. Should return 0 for "knowledge" with only 1 element (calls handleKnowledgeListCommand)', async () => {
		const result = await run(['knowledge']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, []);
	});

	// Attack vector 7: 'config' with args[1] being 'Doctor' (wrong case) → handleConfigCommand (NOT handleDoctorCommand)
	it('7. Should call handleConfigCommand for "config Doctor" (wrong case)', async () => {
		const result = await run(['config', 'Doctor']);

		expect(result).toBe(0);
		expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		expect(mockHandleConfigCommand).toHaveBeenCalledWith(cwd, ['Doctor']);
	});

	// Attack vector 8: 'evidence' with args[1] being 'Summary' (wrong case) → handleEvidenceCommand (NOT handleEvidenceSummaryCommand)
	it('8. Should call handleEvidenceCommand for "evidence Summary" (wrong case)', async () => {
		const result = await run(['evidence', 'Summary']);

		expect(result).toBe(0);
		expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
		expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(cwd, ['Summary']);
	});

	// Attack vector 9: 'knowledge' with args[1] being 'Migrate' (wrong case) → handleKnowledgeListCommand (falls through), returns 0
	it('9. Should return 0 for "knowledge Migrate" (wrong case, calls handleKnowledgeListCommand)', async () => {
		const result = await run(['knowledge', 'Migrate']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeMigrateCommand).not.toHaveBeenCalled();
		expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(cwd, [
			'Migrate',
		]);
	});

	// Attack vector 10: null in args array: `[null]` → TypeScript allows this at runtime; should hit unknown command default, returns 1
	it('10. Should return 1 for args array with null element', async () => {
		// @ts-expect-error - Testing runtime behavior with null in array
		const result = await run([null]);

		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: null'),
		);
	});

	// Additional edge cases

	// Test with empty args array
	it('Should return 1 for empty args array', async () => {
		const result = await run([]);

		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Usage: bunx opencode-swarm run <command>'),
		);
	});

	// Test sync handler (handleAgentsCommand)
	it('Should correctly handle sync handler (agents)', async () => {
		mockHandleAgentsCommand.mockReturnValueOnce('agents result');

		const result = await run(['agents']);

		expect(result).toBe(0);
		expect(mockConsoleLog).toHaveBeenCalledWith('agents result');
	});

	// Test sync handler returning null
	it('Should call console.log(null) when sync handler returns null', async () => {
		mockHandleAgentsCommand.mockReturnValueOnce(null as unknown as string);

		const result = await run(['agents']);

		expect(result).toBe(0);
		expect(mockConsoleLog).toHaveBeenCalledWith(null);
	});

	// Test sync handler returning undefined
	it('Should call console.log(undefined) when sync handler returns undefined', async () => {
		mockHandleAgentsCommand.mockReturnValueOnce(undefined as unknown as string);

		const result = await run(['agents']);

		expect(result).toBe(0);
		expect(mockConsoleLog).toHaveBeenCalledWith(undefined);
	});

	// Test knowledge quarantine with correct case
	it('Should call handleKnowledgeQuarantineCommand for "knowledge quarantine"', async () => {
		const result = await run(['knowledge', 'quarantine', '123', 'test reason']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeQuarantineCommand).toHaveBeenCalledWith(cwd, [
			'123',
			'test reason',
		]);
	});

	// Test knowledge restore with correct case
	it('Should call handleKnowledgeRestoreCommand for "knowledge restore"', async () => {
		const result = await run(['knowledge', 'restore', '123']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeRestoreCommand).toHaveBeenCalledWith(cwd, [
			'123',
		]);
	});

	// Test knowledge migrate with correct case
	it('Should call handleKnowledgeMigrateCommand for "knowledge migrate"', async () => {
		const result = await run(['knowledge', 'migrate']);

		expect(result).toBe(0);
		expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(cwd, []);
	});

	// Test config doctor with correct case
	it('Should call handleDoctorCommand for "config doctor"', async () => {
		const result = await run(['config', 'doctor']);

		expect(result).toBe(0);
		expect(mockHandleDoctorCommand).toHaveBeenCalledWith(cwd, []);
		expect(mockHandleConfigCommand).not.toHaveBeenCalled();
	});

	// Test evidence summary with correct case
	it('Should call handleEvidenceSummaryCommand for "evidence summary"', async () => {
		const result = await run(['evidence', 'summary']);

		expect(result).toBe(0);
		expect(mockHandleEvidenceSummaryCommand).toHaveBeenCalledWith(cwd);
		expect(mockHandleEvidenceCommand).not.toHaveBeenCalled();
	});

	// Test unknown command
	it('Should return 1 for unknown command', async () => {
		const result = await run(['unknown']);

		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: unknown'),
		);
	});
});
