import { type ConfigDoctorResult, type ModelAvailability } from '../services/config-doctor';
/**
 * Format tool doctor result as markdown for command output.
 *
 * Exported for unit testing of the BLOCKING footer enforcement path.
 */
export declare function formatToolDoctorMarkdown(result: ConfigDoctorResult): string;
export declare function loadModelAvailability(directory: string, client: unknown, options?: {
    timeoutMs?: number;
}): Promise<ModelAvailability | undefined>;
/**
 * Handle /swarm config doctor command.
 * Maps to: config doctor service (runConfigDoctor)
 */
export declare function handleDoctorCommand(directory: string, args: string[], options?: {
    client?: unknown;
}): Promise<string>;
/**
 * Handle /swarm doctor tools command.
 * Maps to: tool doctor service (runToolDoctor)
 */
export declare function handleDoctorToolsCommand(directory: string, _args: string[]): Promise<string>;
