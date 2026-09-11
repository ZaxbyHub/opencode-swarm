/** Knowledge system exports for opencode-swarm. */

export * from './cohort-identity.js';
// Explicit (not `export *`) because identity.ts also exports a file-scoped
// `_internals` DI seam that would collide with cohort-identity's at this
// barrel. The seam stays importable from './identity.js' directly.
export {
	deriveProjectHash,
	readProjectIdentity,
	resolveIdentityPath,
	writeProjectIdentity,
} from './identity.js';
export type { ProjectIdentity } from './identity.js';
