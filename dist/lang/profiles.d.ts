/**
 * Language Profile Registry - Pure Data Types
 *
 * This file defines the LanguageProfile interface and LanguageRegistry class.
 * No tool logic, no subprocess calls - pure data definitions only.
 */
export interface BuildCommand {
    name: string;
    cmd: string;
    detectFile?: string;
    priority: number;
}
export interface TestFramework {
    name: string;
    detect: string;
    cmd: string;
    priority: number;
}
export interface LintTool {
    name: string;
    detect: string;
    cmd: string;
    priority: number;
}
export interface LanguageProfile {
    id: string;
    displayName: string;
    tier: 1 | 2 | 3;
    extensions: string[];
    /**
     * Reserved for future "parser-only" entries (e.g. css, bash, ini, regex,
     * and the tsx parser-grammar split) that should register a tree-sitter
     * parser but never participate in test/build/lint dispatch. Currently
     * unused — populated in a later phase.
     */
    parserOnly?: boolean;
    treeSitter: {
        grammarId: string;
        wasmFile: string;
        /**
         * Tree-sitter node names that represent comments for this language.
         * Used by tools that strip comments (e.g. ast-diff, syntax-check).
         *
         * Optional in the type because tests construct ad-hoc profiles for
         * fixtures that don't exercise comment-stripping. Production profiles
         * MUST populate this — enforced by
         * `tests/unit/lang/profile-registry-parity.test.ts` against every
         * profile in `LANGUAGE_REGISTRY`. Source of truth lives here;
         * `src/lang/registry.ts` exposes a parity subset for the parser-only
         * registry.
         */
        commentNodes?: string[];
    };
    build: {
        detectFiles: string[];
        commands: BuildCommand[];
    };
    test: {
        detectFiles: string[];
        frameworks: TestFramework[];
    };
    lint: {
        detectFiles: string[];
        linters: LintTool[];
    };
    audit: {
        detectFiles: string[];
        command: string | null;
        outputFormat: 'json' | 'text';
    };
    sast: {
        nativeRuleSet: string | null;
        semgrepSupport: 'ga' | 'beta' | 'experimental' | 'none';
    };
    prompts: {
        coderConstraints: string[];
        reviewerChecklist: string[];
        testConstraints?: string[];
    };
}
export declare class LanguageRegistry {
    private profiles;
    private extensionIndex;
    constructor();
    /**
     * Remove a previously registered profile and any extensions it claimed.
     * Primarily used by tests to clean up after registering fixture profiles
     * into the shared singleton — without this, fixture entries leak across
     * test files in Bun's per-file-but-shared-process test runner. No-op if
     * the id is not registered.
     */
    unregister(id: string): void;
    register(profile: LanguageProfile): void;
    get(id: string): LanguageProfile | undefined;
    getById(id: string): LanguageProfile | undefined;
    getByExtension(ext: string): LanguageProfile | undefined;
    getAll(): LanguageProfile[];
    getTier(tier: 1 | 2 | 3): LanguageProfile[];
}
export declare const LANGUAGE_REGISTRY: LanguageRegistry;
