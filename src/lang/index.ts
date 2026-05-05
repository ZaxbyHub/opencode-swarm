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

// runtime has no _internals — safe to re-export
export * from './runtime';
