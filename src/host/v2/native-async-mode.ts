/**
 * A per-setup, host-verified subagent dialect for OpenCode 2.3.x (PR 3922).
 * 2.3.x's native `subagent` tool is always asynchronous; it has no background
 * input field. The dialect stays opt-in to the *known* minor and is never
 * turned on for the v1 Task tool, where foreground settlement remains valid.
 *
 * Binding (SolCritic contract): ONE immutable dialect is resolved per v2
 * plugin setup from the host version (src/host/v2/setup.ts) and threaded to
 * the boundaries that need it — the v2 tool-hook adapters (src/host/v2/
 * hooks.ts) and the v1 delegation gate (src/hooks/delegation-gate.ts via the
 * shared init core). There is no per-directory registry and no release
 * lifecycle: resolution is pure, cannot fail, and nothing global remains, so
 * neither plugin-init invariant 1 nor bounded-state invariant 8 needs an
 * exception for this flag. The only mutable state in this module is the
 * verified-child FIFO below (bounded, invariant 8), unchanged.
 */
export type V2SubagentDialect = 'legacy' | 'native-2.3';

export function isKnownNativeAsyncSubagentVersion(value: unknown): boolean {
	if (typeof value !== 'string') return false;
	const version = /^2\.(\d+)\.(\d+)(?:[-+][\w.-]+)?$/.exec(value);
	// Deliberately pin the 2.3 dialect. Future minor versions need a new check.
	return version !== null && Number(version[1]) === 3;
}

/**
 * Resolve ONE immutable dialect per plugin setup from the existing version
 * check. Unknown host versions deliberately retain the legacy foreground
 * semantics. Pure and total: no capacity path, no throw, no cleanup — a setup
 * that resolves this can no longer fail at this step.
 */
export function resolveV2SubagentDialect(
	hostVersion: unknown,
): V2SubagentDialect {
	return isKnownNativeAsyncSubagentVersion(hostVersion)
		? 'native-2.3'
		: 'legacy';
}

/** Host-confirmed child identity, used to distinguish a child's completed
 * execution from its parent going idle. Progress events and verified structured
 * tool results are both trusted host surfaces. FIFO bounded. */
const MAX_VERIFIED_CHILDREN = 512;
const parentByVerifiedChild = new Map<string, string>();
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,252}$/;

export function rememberVerifiedNativeChild(
	child: string,
	parent: string,
): boolean {
	if (
		!SESSION_ID_RE.test(child) ||
		!SESSION_ID_RE.test(parent) ||
		child === parent
	)
		return false;
	// Never allow a session to be reassigned to a different parent.
	const original = parentByVerifiedChild.get(child);
	if (original && original !== parent) return false;
	parentByVerifiedChild.delete(child);
	if (parentByVerifiedChild.size >= MAX_VERIFIED_CHILDREN) {
		const first = parentByVerifiedChild.keys().next().value;
		if (first !== undefined) parentByVerifiedChild.delete(first);
	}
	parentByVerifiedChild.set(child, parent);
	return true;
}

export function isTrackedNativeChildSession(child: string): boolean {
	return parentByVerifiedChild.has(child);
}

/** Returns the host-proven parent only; model text or tool arguments cannot
 * create an entry here. The completion adapter must bind the child to the
 * exact parent receiving the host's synthetic completion notice. */
export function verifiedNativeChildParent(child: string): string | undefined {
	return parentByVerifiedChild.get(child);
}

export function clearTrackedNativeChildrenForTests(): void {
	parentByVerifiedChild.clear();
}
