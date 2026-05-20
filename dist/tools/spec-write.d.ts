/**
 * spec_write — Safe writer for `.swarm/spec.md`.
 *
 * Allows the spec_writer agent (or architect) to update the project spec
 * without granting general filesystem write access. Validates target path is
 * `.swarm/spec.md`, performs an atomic rename, and rejects content that would
 * break the basic shape (must be markdown, must contain a top-level heading).
 */
import { createSwarmTool } from './create-tool.js';
export declare const spec_write: ReturnType<typeof createSwarmTool>;
export declare const _internals: {
    spec_write: typeof spec_write;
};
