/**
 * Config Doctor Service
 *
 * Validates opencode-swarm config shape, detects stale/invalid settings,
 * classifies findings by severity, and proposes safe auto-fixes.
 */
import type { PluginConfig } from '../config/schema';
/** Severity levels for config findings */
export type FindingSeverity = 'info' | 'warn' | 'error';
/** A single config finding */
export interface ConfigFinding {
    /** Unique identifier for this finding type */
    id: string;
    /** Human-readable title */
    title: string;
    /** Detailed description */
    description: string;
    /** Severity level */
    severity: FindingSeverity;
    /** Path to the config key (dot notation) */
    path: string;
    /** Current invalid/stale value */
    currentValue?: unknown;
    /** Proposed safe fix (if available) */
    proposedFix?: ConfigFix;
    /** Whether this is auto-fixable (safe, non-destructive) */
    autoFixable: boolean;
}
/** A proposed config fix */
export interface ConfigFix {
    /** Type of fix */
    type: 'remove' | 'update' | 'add';
    /** Path to the config key (dot notation) */
    path: string;
    /** Value to set (for update/add) */
    value?: unknown;
    /** Description of what the fix does */
    description: string;
    /** Risk level - only 'low' is auto-fixable */
    risk: 'low' | 'medium' | 'high';
}
/** Result of running the config doctor */
export interface ConfigDoctorResult {
    /** All findings from the doctor run */
    findings: ConfigFinding[];
    /** Findings by severity */
    summary: {
        info: number;
        warn: number;
        error: number;
    };
    /** Whether any auto-fixable issues were found */
    hasAutoFixableIssues: boolean;
    /** Timestamp of the run */
    timestamp: number;
    /** The config that was analyzed */
    configSource: string;
}
/** Backup artifact for rollback */
export interface ConfigBackup {
    /** When the backup was created */
    createdAt: number;
    /** The backed up config content */
    configPath: string;
    /** The raw config content */
    content: string;
    /** Hash of content for integrity verification */
    contentHash: string;
}
/**
 * Get config file paths
 */
export declare function getConfigPaths(directory: string): {
    userConfigPath: string;
    projectConfigPath: string;
};
/**
 * Create a backup of the current config
 */
export declare function createConfigBackup(directory: string): ConfigBackup | null;
/**
 * Write a backup artifact to .swarm directory
 * Persists full backup content to support rollback/restore
 */
export declare function writeBackupArtifact(directory: string, backup: ConfigBackup): string;
/**
 * Restore config from a backup artifact
 * @param backupPath - Path to the backup artifact file
 * @param directory - The working directory (for validating config paths)
 * @returns the path to the restored config file, or null if restore failed
 */
export declare function restoreFromBackup(backupPath: string, directory: string): string | null;
/**
 * Run the config doctor on a loaded config
 */
export declare function runConfigDoctor(config: PluginConfig, directory: string): ConfigDoctorResult;
/**
 * Apply safe auto-fixes to config
 * Only applies low-risk, non-destructive fixes
 */
export declare function applySafeAutoFixes(directory: string, result: ConfigDoctorResult): {
    appliedFixes: ConfigFix[];
    updatedConfigPath: string | null;
};
/**
 * Write doctor result to .swarm directory for GUI consumption
 */
export declare function writeDoctorArtifact(directory: string, result: ConfigDoctorResult): string;
/**
 * Check if config doctor should run on startup
 */
export declare function shouldRunOnStartup(automationConfig: {
    mode: string;
    capabilities?: Record<string, boolean>;
} | undefined): boolean;
/**
 * Full config doctor run with backup and fix application
 */
export declare function runConfigDoctorWithFixes(directory: string, config: PluginConfig, autoFix?: boolean): Promise<{
    result: ConfigDoctorResult;
    backupPath: string | null;
    appliedFixes: ConfigFix[];
    updatedConfigPath: string | null;
    artifactPath: string | null;
}>;
