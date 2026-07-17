import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import OpenCodeSwarmPlugin from '../../src/index';
import { writeApprovedPlan } from './approved-plan';

function ctxFor(directory: string) {
	return {
		client: {} as unknown,
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	};
}

export function createKnowledgeProject(): string {
	const directory = realpathSync(
		mkdtempSync(path.join(tmpdir(), 'swarm-e2e-1849-')),
	);
	mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	return directory;
}

export async function bootKnowledgeHost(directory: string): Promise<{
	hooks: Record<string, (...args: unknown[]) => Promise<unknown>>;
	tool: Record<
		string,
		{ execute: (args: unknown, dir: string, ctx: unknown) => Promise<unknown> }
	>;
}> {
	const opencodeDir = path.join(directory, '.opencode');
	mkdirSync(opencodeDir, { recursive: true });
	await writeApprovedPlan(directory, [{ id: '1.1', files: ['src/index.ts'] }]);
	writeFileSync(
		path.join(opencodeDir, 'opencode-swarm.json'),
		JSON.stringify(
			{ version_check: false, knowledge: { enabled: true } },
			null,
			2,
		),
	);
	const result = await (
		OpenCodeSwarmPlugin as unknown as {
			server: (
				ctx: ReturnType<typeof ctxFor>,
			) => Promise<Record<string, unknown>>;
		}
	).server(ctxFor(directory));
	return {
		hooks: result as unknown as Record<
			string,
			(...args: unknown[]) => Promise<unknown>
		>,
		tool: (result.tool ?? {}) as Record<
			string,
			{
				execute: (args: unknown, dir: string, ctx: unknown) => Promise<unknown>;
			}
		>,
	};
}
