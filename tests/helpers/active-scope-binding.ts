import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Plan } from '../../src/config/plan-schema';
import {
	claimScopeBindingForChild,
	createScopeBinding,
	registerScopeBinding,
} from '../../src/scope/scope-binding';
import { getAgentSession } from '../../src/state';

export function installActiveScopeBinding(input: {
	directory: string;
	childSessionId: string;
	taskId: string;
	files: string[];
	parentSessionId?: string;
	dispatchCallId?: string;
}): Plan {
	const plan: Plan = {
		schema_version: '1.0.0',
		title: 'Active scope test fixture',
		swarm: 'test',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Test',
				status: 'in_progress',
				tasks: [
					{
						id: input.taskId,
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'exercise identity-bound scope',
						depends: [],
						files_touched: input.files,
					},
				],
			},
		],
	};
	fs.mkdirSync(path.join(input.directory, '.swarm'), { recursive: true });
	fs.writeFileSync(
		path.join(input.directory, '.swarm', 'plan.json'),
		JSON.stringify(plan),
	);
	const session = getAgentSession(input.childSessionId);
	if (!session) throw new Error('test session missing');
	session.currentTaskId = input.taskId;
	session.declaredCoderScope = [...input.files];
	const parentSessionId =
		input.parentSessionId ?? `${input.childSessionId}-parent`;
	const dispatchCallId =
		input.dispatchCallId ?? `${input.childSessionId}-task-call`;
	const binding = createScopeBinding({
		directory: input.directory,
		plan,
		taskId: input.taskId,
		files: input.files,
		ownerSessionId: parentSessionId,
		ownerMessageId: dispatchCallId,
		dispatchCallId,
		source: 'plan',
	});
	if (!binding) throw new Error('scope fixture was not created');
	registerScopeBinding(binding);
	const active = claimScopeBindingForChild({
		directory: input.directory,
		parentSessionId,
		childSessionId: input.childSessionId,
		dispatchCallId,
	});
	if (!active) throw new Error('scope fixture was not activated');
	const claimed = active.claimed;
	const scopesDir = path.join(input.directory, '.swarm', 'scopes');
	fs.mkdirSync(scopesDir, { recursive: true });
	fs.writeFileSync(
		path.join(
			scopesDir,
			`binding-${claimed.taskId}-${claimed.bindingId}-${claimed.generationId}.json`,
		),
		JSON.stringify(claimed, null, 2),
	);
	return plan;
}
