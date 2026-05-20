import { type Parser } from './runtime';
export declare const _internals: {
    getLanguageForExtension: typeof getLanguageForExtension;
    listSupportedLanguages: typeof listSupportedLanguages;
    getParserForFile: typeof getParserForFile;
    isSupportedFile: typeof isSupportedFile;
};
export interface LanguageDefinition {
    id: string;
    extensions: string[];
    commentNodes: string[];
}
export declare const languageDefinitions: LanguageDefinition[];
export declare function getLanguageForExtension(extension: string): LanguageDefinition | undefined;
export declare function listSupportedLanguages(): readonly LanguageDefinition[];
/**
 * Get a parser for a specific file path
 * Determines language from file extension, loads grammar, returns configured parser
 *
 * @param filePath - Absolute or relative path to the file
 * @returns Parser instance or null if language not supported
 */
export declare function getParserForFile(filePath: string): Promise<Parser | null>;
/**
 * Check if a file path has a supported language extension
 *
 * @param filePath - Path to check
 * @returns true if extension is supported
 */
export declare function isSupportedFile(filePath: string): boolean;
