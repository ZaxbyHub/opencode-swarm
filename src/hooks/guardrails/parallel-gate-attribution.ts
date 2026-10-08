/**
 * Stage A attribution of `pre_check_batch` while several coders are in flight.
 *
 * A gate tool run is credited to the calling session's single
 * `currentTaskId`. With several tasks awaiting Stage A — parallel coders (v8
 * parallelization), or Turbo's coder re-dispatch before Stage A — that is
 * whichever coder returned LAST, not the task whose files the gate checked:
 * a `pre_check_batch` verdict lands on the wrong task, and the task that was
 * actually checked never reaches Stage B.
 *
 * While the session has two or more tasks at `coder_delegated` — or exactly
 * one that is NOT its `currentTaskId` (the last-returned coder already passed
 * Stage A, so `currentTaskId` still names it while the remaining task awaits)
 * — a `pre_check_batch` run is credited by its `files` to the one in-flight
 * task whose planned scope (`files_touched`) contains every checked file — or
 * to none, with an advisory. The caller applies this to `pre_check_batch`
 * only: the other gate tools carry no Stage A verdict and some take no file
 * argument. With no task in flight, or exactly one that IS `currentTaskId`,
 * the caller keeps its existing attribution (`currentTaskId`, then the
 * durable post-reset fallback).
 */
import * as path from 'node:path';
import { loadPlanJsonOnly } from '../../plan/manager';
import { scopeContains } from '../../scope/scope-binding';
import { swarmState } from '../../state';

export type ParallelGateAttribution =
	| { kind: 'none' }
	| { kind: 'task'; taskId: string }
	| { kind: 'unattributable'; message: string };

function toProjectRelative(directory: string, file: string): string {
	const trimmed = file.trim();
	if (!path.isAbsolute(trimmed)) return trimmed.replace(/\\/g, '/');
	const relative = path.relative(directory, trimmed);
	return relative.replace(/\\/g, '/');
}

function inFlightTasks(sessionID: string): string[] {
	const states = swarmState.agentSessions.get(sessionID)?.taskWorkflowStates;
	if (!states) return [];
	return [...states.entries()]
		.filter(([, state]) => state === 'coder_delegated')
		.map(([taskId]) => taskId)
		.sort();
}

/**
 * File-based attribution applies whenever a task awaits Stage A that
 * `currentTaskId` might not name: two or more awaiting, or exactly one that
 * differs from a set `currentTaskId` (e.g. the last-returned coder's task
 * already passed Stage A and the remaining parallel task is checked next).
 */
function needsFileAttribution(
	awaiting: readonly string[],
	currentTaskId: string | null | undefined,
): boolean {
	if (awaiting.length === 0) return false;
	// With no currentTaskId at all (e.g. after reset-session) nothing would
	// misattribute: the caller's durable post-reset fallback handles it.
	if (awaiting.length === 1)
		return !!currentTaskId && awaiting[0] !== currentTaskId;
	return true;
}

export async function resolveParallelGateTaskAttribution(
	directory: string,
	sessionID: string,
	files: readonly string[] | null,
): Promise<ParallelGateAttribution> {
	const candidates = inFlightTasks(sessionID);
	const currentTaskId = swarmState.agentSessions.get(sessionID)?.currentTaskId;
	if (!needsFileAttribution(candidates, currentTaskId)) return { kind: 'none' };

	// Only tasks of the current plan count: an entry for a task that is no
	// longer planned (a replaced plan in a long-lived session) awaits nothing.
	let scopes: Map<string, readonly string[]>;
	try {
		const plan = await loadPlanJsonOnly(directory);
		scopes = new Map();
		for (const phase of plan?.phases ?? []) {
			for (const task of phase.tasks ?? []) {
				if (candidates.includes(task.id)) {
					scopes.set(task.id, task.files_touched ?? []);
				}
			}
		}
	} catch (error) {
		return {
			kind: 'unattributable',
			message: `STAGE A ATTRIBUTION: ${candidates.length} tasks are awaiting Stage A (${candidates.join(', ')}), but the plan could not be read (${error instanceof Error ? error.message : String(error)}). Nothing was credited.`,
		};
	}
	const inFlight = candidates.filter((taskId) => scopes.has(taskId));
	if (!needsFileAttribution(inFlight, currentTaskId)) return { kind: 'none' };

	const prefix =
		inFlight.length === 1
			? `STAGE A ATTRIBUTION: task ${inFlight[0]} is awaiting Stage A but the session's current task is ${currentTaskId}, so this gate run is credited by the files it checked`
			: `STAGE A ATTRIBUTION: ${inFlight.length} tasks are awaiting Stage A in parallel (${inFlight.join(', ')}), so this gate run is credited by the files it checked`;
	const checked = (files ?? [])
		.map((file) => toProjectRelative(directory, file))
		.filter((file) => file.length > 0);
	if (checked.length === 0) {
		return {
			kind: 'unattributable',
			message: `${prefix}, but it names no files. Re-run it with \`files\` set to ONE task's files.`,
		};
	}

	const owners = inFlight.filter((taskId) => {
		const scope = scopes.get(taskId) ?? [];
		return (
			scope.length > 0 && checked.every((file) => scopeContains(scope, file))
		);
	});
	if (owners.length === 1) return { kind: 'task', taskId: owners[0] };
	return {
		kind: 'unattributable',
		message:
			owners.length === 0
				? `${prefix}, but no single in-flight task's planned files contain all of them. Re-run it with \`files\` set to ONE task's files.`
				: `${prefix}, but several in-flight tasks (${owners.join(', ')}) contain all of them. Re-run it with \`files\` narrowed to ONE task's files.`,
	};
}
