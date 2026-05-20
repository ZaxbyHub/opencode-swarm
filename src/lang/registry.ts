import { extname } from 'node:path';
import { loadGrammar, type Parser } from './runtime';

export const _internals: {
	getLanguageForExtension: typeof getLanguageForExtension;
	listSupportedLanguages: typeof listSupportedLanguages;
	getParserForFile: typeof getParserForFile;
	isSupportedFile: typeof isSupportedFile;
} = {
	getLanguageForExtension,
	listSupportedLanguages,
	getParserForFile,
	isSupportedFile,
} as const;

export interface LanguageDefinition {
	id: string;
	extensions: string[];
	commentNodes: string[];
}

export const languageDefinitions: LanguageDefinition[] = [
	{
		id: 'javascript',
		extensions: ['.js', '.jsx'],
		commentNodes: ['comment', 'line_comment', 'block_comment'],
	},
	{
		id: 'typescript',
		extensions: ['.ts'],
		commentNodes: ['comment', 'line_comment', 'block_comment'],
	},
	{
		id: 'python',
		extensions: ['.py'],
		commentNodes: ['comment'],
	},
	{
		id: 'go',
		extensions: ['.go'],
		commentNodes: ['comment'],
	},
	{
		id: 'rust',
		extensions: ['.rs'],
		commentNodes: ['line_comment', 'block_comment'],
	},
	{
		id: 'php',
		extensions: ['.php', '.phtml'],
		commentNodes: ['comment'],
	},
	{
		id: 'java',
		extensions: ['.java'],
		commentNodes: ['line_comment', 'block_comment'],
	},
	{
		id: 'c',
		extensions: ['.c', '.h'],
		commentNodes: ['comment'],
	},
	{
		id: 'cpp',
		extensions: ['.cpp', '.cxx', '.cc', '.hpp', '.hxx', '.hh'],
		commentNodes: ['comment'],
	},
	{
		id: 'csharp',
		extensions: ['.cs'],
		commentNodes: ['comment'],
	},
	{
		id: 'ruby',
		extensions: ['.rb'],
		commentNodes: ['comment'],
	},
	{
		id: 'swift',
		extensions: ['.swift'],
		commentNodes: ['comment', 'multiline_comment'],
	},
	{
		id: 'kotlin',
		extensions: ['.kt', '.kts'],
		commentNodes: ['line_comment', 'multiline_comment'],
	},
	{
		id: 'dart',
		extensions: ['.dart'],
		commentNodes: ['comment', 'documentation_comment'],
	},
	{
		id: 'css',
		extensions: ['.css'],
		commentNodes: ['comment'],
	},
	{
		id: 'bash',
		extensions: ['.sh', '.bash'],
		commentNodes: ['comment'],
	},
	{
		id: 'powershell',
		extensions: ['.ps1', '.psm1'],
		commentNodes: ['comment'],
	},
	{
		id: 'ini',
		extensions: ['.ini', '.cfg', '.conf'],
		commentNodes: ['comment'],
	},
	{
		id: 'regex',
		extensions: ['.regex'],
		commentNodes: [],
	},
	{
		id: 'tsx',
		extensions: ['.tsx'],
		commentNodes: ['comment'],
	},
];

const extensionMap = new Map<string, LanguageDefinition>();
for (const definition of languageDefinitions) {
	for (const extension of definition.extensions) {
		extensionMap.set(extension, definition);
	}
}

export function getLanguageForExtension(
	extension: string,
): LanguageDefinition | undefined {
	return extensionMap.get(extension.toLowerCase());
}

export function listSupportedLanguages(): readonly LanguageDefinition[] {
	return languageDefinitions;
}

/**
 * Get a parser for a specific file path
 * Determines language from file extension, loads grammar, returns configured parser
 *
 * @param filePath - Absolute or relative path to the file
 * @returns Parser instance or null if language not supported
 */
export async function getParserForFile(
	filePath: string,
): Promise<Parser | null> {
	const extension = extname(filePath).toLowerCase();
	const language = getLanguageForExtension(extension);

	if (!language) {
		return null;
	}

	try {
		return await loadGrammar(language.id);
	} catch {
		return null;
	}
}

/**
 * Check if a file path has a supported language extension
 *
 * @param filePath - Path to check
 * @returns true if extension is supported
 */
export function isSupportedFile(filePath: string): boolean {
	const extension = extname(filePath).toLowerCase();
	return extensionMap.has(extension);
}
