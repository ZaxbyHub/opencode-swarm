export { _internals as detectorInternals, detectProjectLanguages, getProfileForFile, } from './detector';
export * from './profiles';
export type { LanguageDefinition } from './registry';
export { _internals as registryInternals, getLanguageForExtension, getParserForFile, isSupportedFile, languageDefinitions, listSupportedLanguages, } from './registry';
export * from './runtime';
