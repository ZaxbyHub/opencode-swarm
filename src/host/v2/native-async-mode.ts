/**
 * A project-scoped, host-verified compatibility flag for OpenCode 2.3.x.
 * 2.3.x's native `subagent` tool is always asynchronous; it has no background
 * input field. Keep this opt-in to the *known* dialect and never turn it on for
 * the v1 Task tool, where foreground settlement remains valid.
 *
 * Ownership is per v2 plugin setup instance. One cleanup must not remove the
 * mode while another live setup for the same project still owns it.
 */
const ownersByDirectory = new Map<string, Set<string>>();
const MAX_LIVE_PROJECTS = 128;

export function isKnownNativeAsyncSubagentVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const version = /^2\.(\d+)\.(\d+)(?:[-+][\w.\-]+)?$/.exec(value);
  // Deliberately pin the 2.3 dialect. Future minor versions need a new check.
  return version !== null && Number(version[1]) === 3;
}

export function registerNativeV2AsyncSubagents(
  directory: string,
  owner: string,
): () => void {
  if (!directory || !owner) throw new Error('v2 native async mode: missing owner identity');
  let owners = ownersByDirectory.get(directory);
  if (!owners) {
    if (ownersByDirectory.size >= MAX_LIVE_PROJECTS) {
      throw new Error('v2 native async mode: project registry at capacity');
    }
    owners = new Set<string>();
    ownersByDirectory.set(directory, owners);
  }
  owners.add(owner);
  return () => {
    const current = ownersByDirectory.get(directory);
    if (!current) return;
    current.delete(owner);
    if (current.size === 0) ownersByDirectory.delete(directory);
  };
}

export function isNativeV2AsyncSubagentHost(directory: string): boolean {
  return (ownersByDirectory.get(directory)?.size ?? 0) > 0;
}

/** Host-confirmed child identity, used to distinguish a child's completed
 * execution from its parent going idle. Progress events and verified structured
 * tool results are both trusted host surfaces. FIFO bounded. */
const MAX_VERIFIED_CHILDREN = 512;
const parentByVerifiedChild = new Map<string, string>();
const SESSION_ID_RE = /^ses_[A-Za-z0-9_-]{1,252}$/;

export function rememberVerifiedNativeChild(child: string, parent: string): boolean {
  if (!SESSION_ID_RE.test(child) || !SESSION_ID_RE.test(parent) || child === parent) return false;
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
