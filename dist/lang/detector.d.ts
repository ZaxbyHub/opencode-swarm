/**
 * Language Detection Utilities
 *
 * Provides detectProjectLanguages() for scanning a project directory
 * and getProfileForFile() for resolving a language profile from a file path.
 * No tool logic — pure detection only.
 */
import { type LanguageProfile } from './profiles.js';
export declare const _internals: {
    getProfileForFile: typeof getProfileForFile;
    detectProjectLanguages: typeof detectProjectLanguages;
};
/**
 * Resolve a language profile from a file path based on its extension.
 * Returns undefined for files with no extension or unknown extensions.
 */
export declare function getProfileForFile(filePath: string): LanguageProfile | undefined;
/**
 * Scan a project directory (and immediate subdirectories) to detect active languages.
 * Detection is based on presence of build indicator files or source files with known extensions.
 * Returns unique profiles in priority order (Tier 1 first, then Tier 2, then Tier 3).
 * Skips unreadable directories silently.
 */
export declare function detectProjectLanguages(projectDir: string): Promise<LanguageProfile[]>;
