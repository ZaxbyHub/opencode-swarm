import { swarmState } from '../../src/state';

interface ScopeGuardInternals {
	resolveTaskId: (session: unknown) => string | null;
	resolveAuthorizedScopeBinding: (input: {
		directory: string;
		activeSessionId: string;
		taskId: string;
	}) => { files: string[] } | null;
	resolveWriteTargets?: (
		toolName: string,
		args: unknown,
		context: { directory: string },
	) =>
		| { status: 'resolved'; paths: string[] }
		| { status: 'unverifiable'; reason: string };
}

/** Adapt pre-v2 scope-guard fixtures without adding a production fallback. */
export function installScopeGuardBindingSeam(
	internals: ScopeGuardInternals,
	pending?: (taskId: string) => string[] | null,
): () => void {
	const realTask = internals.resolveTaskId;
	const realBinding = internals.resolveAuthorizedScopeBinding;
	internals.resolveTaskId = (session: unknown) => {
		const state = session as { currentTaskId?: string | null } | undefined;
		return state?.currentTaskId ?? '1.1';
	};
	internals.resolveAuthorizedScopeBinding = ({ activeSessionId, taskId }) => {
		const session = swarmState.agentSessions.get(activeSessionId);
		const files = session?.declaredCoderScope ?? pending?.(taskId) ?? null;
		return files && files.length > 0 ? { files } : null;
	};
	return () => {
		internals.resolveTaskId = realTask;
		internals.resolveAuthorizedScopeBinding = realBinding;
	};
}

/** Preserve pre-registry scope-guard fixtures as unit tests of path iteration. */
export function installLegacyScopeGuardTargetSeam(
	internals: ScopeGuardInternals,
): () => void {
	const realResolver = internals.resolveWriteTargets;
	if (!realResolver) return () => {};
	internals.resolveWriteTargets = (_toolName, args) => {
		if (typeof args !== 'object' || args === null || Array.isArray(args)) {
			return { status: 'resolved', paths: [] };
		}
		const source = args as Record<string, unknown>;
		const paths: string[] = [];
		for (const key of ['path', 'filePath', 'file', 'target']) {
			const value = source[key];
			if (typeof value === 'string' && value.length > 0) paths.push(value);
		}
		for (const key of ['files', 'paths', 'targetFiles']) {
			const value = source[key];
			if (!Array.isArray(value)) continue;
			for (const item of value) {
				if (typeof item === 'string' && item.length > 0) paths.push(item);
			}
		}
		return { status: 'resolved', paths: [...new Set(paths)] };
	};
	return () => {
		internals.resolveWriteTargets = realResolver;
	};
}
