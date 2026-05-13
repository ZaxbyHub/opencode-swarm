import type { AgentDefinition } from '../agents/index.js';
export { handleAcknowledgeSpecDriftCommand } from './acknowledge-spec-drift';
export { handleAgentsCommand } from './agents';
export { handleAnalyzeCommand } from './analyze';
export { handleArchiveCommand } from './archive';
export { handleBenchmarkCommand } from './benchmark';
export { handleBrainstormCommand } from './brainstorm';
export { handleCheckpointCommand } from './checkpoint';
export { handleClarifyCommand } from './clarify';
export { handleCloseCommand } from './close';
export type { CommandName } from './command-names.js';
export { COMMAND_NAME_SET, COMMAND_NAMES } from './command-names.js';
export { handleConfigCommand } from './config';
export { handleCouncilCommand } from './council';
export { handleCurateCommand } from './curate';
export { handleDarkMatterCommand } from './dark-matter';
export { handleDeepDiveCommand } from './deep-dive';
export { handleDiagnoseCommand } from './diagnose';
export { handleDoctorCommand } from './doctor';
export { handleEvidenceCommand, handleEvidenceSummaryCommand, } from './evidence';
export { handleExportCommand } from './export';
export { handleFullAutoCommand } from './full-auto';
export { handleHandoffCommand } from './handoff';
export { handleHistoryCommand } from './history';
export { handleKnowledgeListCommand, handleKnowledgeMigrateCommand, handleKnowledgeQuarantineCommand, handleKnowledgeRestoreCommand, } from './knowledge';
export { handlePlanCommand } from './plan';
export { handlePreflightCommand } from './preflight';
export { handlePromoteCommand } from './promote';
export { handleQaGatesCommand } from './qa-gates';
export { handleHelpCommand } from './registry';
export type { CommandContext, CommandEntry, RegisteredCommand, } from './registry.js';
export { COMMAND_REGISTRY, resolveCommand, VALID_COMMANDS, } from './registry.js';
export { handleResetCommand } from './reset';
export { handleResetSessionCommand } from './reset-session';
export { handleRetrieveCommand } from './retrieve';
export { handleRollbackCommand } from './rollback';
export { handleSimulateCommand } from './simulate';
export { handleSpecifyCommand } from './specify';
export { handleStatusCommand } from './status';
export { handleSyncPlanCommand } from './sync-plan';
export { handleTurboCommand } from './turbo';
export { handleWriteRetroCommand } from './write-retro';
export declare const LLM_MEDIATION_WARNING: string;
export declare function buildHelpText(): string;
/**
 * Creates a command.execute.before handler for /swarm commands.
 * Uses factory pattern to close over directory and agents.
 */
export declare function createSwarmCommandHandler(directory: string, agents: Record<string, AgentDefinition>, client?: unknown): (input: {
    command: string;
    sessionID: string;
    arguments: string;
}, output: {
    parts: unknown[];
}) => Promise<void>;
