import {
	afterAll,
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
const mockHandleHandoffCommand = mock();
const mockHandleTurboCommand = mock();
const mockHandleRollbackCommand = mock();
const mockHandlePromoteCommand = mock();
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
mock.module('../../../src/commands/handoff.js', () => ({
	handleHandoffCommand: mockHandleHandoffCommand,
}));
mock.module('../../../src/commands/turbo.js', () => ({
	handleTurboCommand: mockHandleTurboCommand,
}));
mock.module('../../../src/commands/rollback.js', () => ({
	handleRollbackCommand: mockHandleRollbackCommand,
}));
mock.module('../../../src/commands/promote.js', () => ({
	handlePromoteCommand: mockHandlePromoteCommand,
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

describe('run() - CLI entry point', () => {
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
		mockHandlePromoteCommand.mockClear();
		mockHandleSimulateCommand.mockClear();
		mockHandleCurateCommand.mockClear();
		mockHandleWriteRetroCommand.mockClear();
		mockHandleCheckpointCommand.mockClear();

		// Set up default mock return values
		// handleAgentsCommand is NOT async - returns string directly
		mockHandleAgentsCommand.mockReturnValue('agents mock output');

		// All other handlers are async
		mockHandleStatusCommand.mockResolvedValue('status mock output');
		mockHandlePlanCommand.mockResolvedValue('plan mock output');
		mockHandleArchiveCommand.mockResolvedValue('archive mock output');
		mockHandleHistoryCommand.mockResolvedValue('history mock output');
		mockHandleConfigCommand.mockResolvedValue('config mock output');
		mockHandleDoctorCommand.mockResolvedValue('doctor mock output');
		mockHandleEvidenceCommand.mockResolvedValue('evidence mock output');
		mockHandleEvidenceSummaryCommand.mockResolvedValue(
			'evidence summary mock output',
		);
		mockHandleDiagnoseCommand.mockResolvedValue('diagnose mock output');
		mockHandlePreflightCommand.mockResolvedValue('preflight mock output');
		mockHandleSyncPlanCommand.mockResolvedValue('sync-plan mock output');
		mockHandleBenchmarkCommand.mockResolvedValue('benchmark mock output');
		mockHandleExportCommand.mockResolvedValue('export mock output');
		mockHandleResetCommand.mockResolvedValue('reset mock output');
		mockHandleRetrieveCommand.mockResolvedValue('retrieve mock output');
		mockHandleClarifyCommand.mockResolvedValue('clarify mock output');
		mockHandleAnalyzeCommand.mockResolvedValue('analyze mock output');
		mockHandleSpecifyCommand.mockResolvedValue('specify mock output');
		mockHandleDarkMatterCommand.mockResolvedValue('dark-matter mock output');
		mockHandleKnowledgeListCommand.mockResolvedValue(
			'knowledge list mock output',
		);
		mockHandleKnowledgeMigrateCommand.mockResolvedValue(
			'knowledge migrate mock output',
		);
		mockHandleKnowledgeQuarantineCommand.mockResolvedValue(
			'knowledge quarantine mock output',
		);
		mockHandleKnowledgeRestoreCommand.mockResolvedValue(
			'knowledge restore mock output',
		);
	});

	afterAll(() => {
		// Restore process.argv
		process.argv = originalArgv;
	});

	it('empty args → returns 1, console.error called with usage message', async () => {
		const result = await run([]);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Usage: bunx opencode-swarm run <command>'),
		);
	});

	it('status → handleStatusCommand called with (cwd, {}), returns 0', async () => {
		const result = await run(['status']);
		expect(result).toBe(0);
		expect(mockHandleStatusCommand).toHaveBeenCalledWith(
			expect.any(String),
			{},
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('status mock output');
	});

	it('plan with extra args → handlePlanCommand called with (cwd, ["--phase", "2"]), returns 0', async () => {
		const result = await run(['plan', '--phase', '2']);
		expect(result).toBe(0);
		expect(mockHandlePlanCommand).toHaveBeenCalledWith(expect.any(String), [
			'--phase',
			'2',
		]);
		expect(mockConsoleLog).toHaveBeenCalledWith('plan mock output');
	});

	it('agents → handleAgentsCommand called with ({}, undefined), returns 0, NOT awaited', async () => {
		const result = await run(['agents']);
		expect(result).toBe(0);
		expect(mockHandleAgentsCommand).toHaveBeenCalledWith({}, undefined);
		expect(mockConsoleLog).toHaveBeenCalledWith('agents mock output');
	});

	it('archive → handleArchiveCommand called, returns 0', async () => {
		const result = await run(['archive']);
		expect(result).toBe(0);
		expect(mockHandleArchiveCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('archive mock output');
	});

	it('history → handleHistoryCommand called, returns 0', async () => {
		const result = await run(['history']);
		expect(result).toBe(0);
		expect(mockHandleHistoryCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('history mock output');
	});

	it('config without doctor → handleConfigCommand called, returns 0', async () => {
		const result = await run(['config']);
		expect(result).toBe(0);
		expect(mockHandleConfigCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		expect(mockConsoleLog).toHaveBeenCalledWith('config mock output');
	});

	it('config doctor → handleDoctorCommand called (not handleConfigCommand), returns 0', async () => {
		const result = await run(['config', 'doctor']);
		expect(result).toBe(0);
		expect(mockHandleDoctorCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockHandleConfigCommand).not.toHaveBeenCalled();
		expect(mockConsoleLog).toHaveBeenCalledWith('doctor mock output');
	});

	it('evidence without summary → handleEvidenceCommand called, returns 0', async () => {
		const result = await run(['evidence']);
		expect(result).toBe(0);
		expect(mockHandleEvidenceCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockHandleEvidenceSummaryCommand).not.toHaveBeenCalled();
		expect(mockConsoleLog).toHaveBeenCalledWith('evidence mock output');
	});

	it('evidence summary → handleEvidenceSummaryCommand called (not handleEvidenceCommand), returns 0', async () => {
		const result = await run(['evidence', 'summary']);
		expect(result).toBe(0);
		expect(mockHandleEvidenceSummaryCommand).toHaveBeenCalledWith(
			expect.any(String),
		);
		expect(mockHandleEvidenceCommand).not.toHaveBeenCalled();
		expect(mockConsoleLog).toHaveBeenCalledWith('evidence summary mock output');
	});

	it('diagnose → handleDiagnoseCommand called, returns 0', async () => {
		const result = await run(['diagnose']);
		expect(result).toBe(0);
		expect(mockHandleDiagnoseCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('diagnose mock output');
	});

	it('preflight → handlePreflightCommand called, returns 0', async () => {
		const result = await run(['preflight']);
		expect(result).toBe(0);
		expect(mockHandlePreflightCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('preflight mock output');
	});

	it('sync-plan → handleSyncPlanCommand called, returns 0', async () => {
		const result = await run(['sync-plan']);
		expect(result).toBe(0);
		expect(mockHandleSyncPlanCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('sync-plan mock output');
	});

	it('benchmark → handleBenchmarkCommand called, returns 0', async () => {
		const result = await run(['benchmark']);
		expect(result).toBe(0);
		expect(mockHandleBenchmarkCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('benchmark mock output');
	});

	it('export → handleExportCommand called, returns 0', async () => {
		const result = await run(['export']);
		expect(result).toBe(0);
		expect(mockHandleExportCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('export mock output');
	});

	it('reset → handleResetCommand called, returns 0', async () => {
		const result = await run(['reset']);
		expect(result).toBe(0);
		expect(mockHandleResetCommand).toHaveBeenCalledWith(expect.any(String), []);
		expect(mockConsoleLog).toHaveBeenCalledWith('reset mock output');
	});

	it('retrieve → handleRetrieveCommand called, returns 0', async () => {
		const result = await run(['retrieve']);
		expect(result).toBe(0);
		expect(mockHandleRetrieveCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('retrieve mock output');
	});

	it('clarify → handleClarifyCommand called, returns 0', async () => {
		const result = await run(['clarify']);
		expect(result).toBe(0);
		expect(mockHandleClarifyCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('clarify mock output');
	});

	it('analyze → handleAnalyzeCommand called, returns 0', async () => {
		const result = await run(['analyze']);
		expect(result).toBe(0);
		expect(mockHandleAnalyzeCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('analyze mock output');
	});

	it('specify → handleSpecifyCommand called, returns 0', async () => {
		const result = await run(['specify']);
		expect(result).toBe(0);
		expect(mockHandleSpecifyCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('specify mock output');
	});

	it('dark-matter → handleDarkMatterCommand called, returns 0', async () => {
		const result = await run(['dark-matter']);
		expect(result).toBe(0);
		expect(mockHandleDarkMatterCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith('dark-matter mock output');
	});

	it('knowledge migrate → handleKnowledgeMigrateCommand called with (cwd, []), returns 0', async () => {
		const result = await run(['knowledge', 'migrate']);
		expect(result).toBe(0);
		expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith(
			'knowledge migrate mock output',
		);
	});

	it('knowledge quarantine with id → handleKnowledgeQuarantineCommand called with (cwd, ["entry-1"]), returns 0', async () => {
		const result = await run(['knowledge', 'quarantine', 'entry-1']);
		expect(result).toBe(0);
		expect(mockHandleKnowledgeQuarantineCommand).toHaveBeenCalledWith(
			expect.any(String),
			['entry-1'],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith(
			'knowledge quarantine mock output',
		);
	});

	it('knowledge restore → handleKnowledgeRestoreCommand called, returns 0', async () => {
		const result = await run(['knowledge', 'restore']);
		expect(result).toBe(0);
		expect(mockHandleKnowledgeRestoreCommand).toHaveBeenCalledWith(
			expect.any(String),
			[],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith(
			'knowledge restore mock output',
		);
	});

	it('knowledge with unknown subcmd → calls handleKnowledgeListCommand (consistent with hook behavior)', async () => {
		const result = await run(['knowledge', 'unknown']);
		expect(result).toBe(0);
		expect(mockHandleKnowledgeListCommand).toHaveBeenCalledWith(
			expect.any(String),
			['unknown'],
		);
		expect(mockHandleKnowledgeMigrateCommand).not.toHaveBeenCalled();
		expect(mockHandleKnowledgeQuarantineCommand).not.toHaveBeenCalled();
		expect(mockHandleKnowledgeRestoreCommand).not.toHaveBeenCalled();
	});

	it('unknown command → returns 1, console.error called with unknown command message', async () => {
		const result = await run(['unknown-cmd']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: unknown-cmd'),
		);
	});

	it('status console.log called with handler output', async () => {
		await run(['status']);
		expect(mockConsoleLog).toHaveBeenCalledWith('status mock output');
	});

	it('handler output is logged via console.log (spot check: plan command)', async () => {
		const customOutput = 'custom plan output';
		mockHandlePlanCommand.mockResolvedValue(customOutput);
		await run(['plan', '--phase', '2']);
		expect(mockConsoleLog).toHaveBeenCalledWith(customOutput);
	});

	// Additional edge cases
	it('doctor standalone → unknown command (only accessible as "config doctor"), returns 1', async () => {
		const result = await run(['doctor', '--verbose']);
		expect(result).toBe(1);
		expect(mockHandleDoctorCommand).not.toHaveBeenCalled();
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: doctor'),
		);
	});

	it('knowledge migrate with extra args → passes extra args correctly', async () => {
		const result = await run(['knowledge', 'migrate', '--dry-run']);
		expect(result).toBe(0);
		expect(mockHandleKnowledgeMigrateCommand).toHaveBeenCalledWith(
			expect.any(String),
			['--dry-run'],
		);
		expect(mockConsoleLog).toHaveBeenCalledWith(
			'knowledge migrate mock output',
		);
	});

	it('evidence summary with extra args → ignores extra args (only takes cwd)', async () => {
		const result = await run(['evidence', 'summary', '--json']);
		expect(result).toBe(0);
		expect(mockHandleEvidenceSummaryCommand).toHaveBeenCalledWith(
			expect.any(String),
		);
		expect(mockHandleEvidenceCommand).not.toHaveBeenCalled();
		expect(mockConsoleLog).toHaveBeenCalledWith('evidence summary mock output');
	});
});
