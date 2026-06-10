// Language detection — explicit exports to avoid leaking _internals
export {
	_internals as detectorInternals,
	detectProjectLanguages,
	getProfileForFile,
} from './detector';
// profiles has no _internals — safe to re-export
export * from './profiles';
export type { LanguageDefinition } from './registry';
// Language registry — explicit exports to avoid conflict
export {
	_internals as registryInternals,
	getLanguageForExtension,
	getParserForFile,
	isSupportedFile,
	languageDefinitions,
	listSupportedLanguages,
} from './registry';

// Tree-sitter runtime — explicit exports so the `_internals` DI seam is
// re-exported under a namespaced name (matching detector/registry) instead of
// leaking as a bare `_internals` via `export *`.
export {
	_internals as runtimeInternals,
	clearParserCache,
	getInitializedLanguages,
	getSupportedLanguages,
	isGrammarAvailable,
	loadGrammar,
	type Parser,
	parserCache,
} from './runtime';
