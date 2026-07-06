/**
 * Shared fixtures and helpers for the issue #1717 skill-generator test files
 * (split per AGENTS.md invariant 7 FR-006 — every new test file under 500 lines).
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { SwarmKnowledgeEntry } from '../../../src/hooks/knowledge-types';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store';
import type { KnowledgeCluster } from '../../../src/services/skill-generator';

export const OLD_ENV = {
	HOME: process.env.HOME,
	LOCALAPPDATA: process.env.LOCALAPPDATA,
	XDG_DATA_HOME: process.env.XDG_DATA_HOME,
};

export function makeTmp(): string {
	return mkdtempSync(path.join(tmpdir(), 'sg-1717-'));
}

export function restoreEnv(): void {
	for (const name of Object.keys(OLD_ENV) as Array<keyof typeof OLD_ENV>) {
		if (OLD_ENV[name] === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = OLD_ENV[name];
		}
	}
}

export function redirectHivePath(tmp: string): void {
	// Redirect platform-specific hive path to temp so hive-affecting helpers
	// hit an empty (non-existent) hive file rather than the real one.
	process.env.HOME = tmp;
	process.env.LOCALAPPDATA = tmp;
	process.env.XDG_DATA_HOME = tmp;
}

export function cleanupTmp(tmp: string): void {
	rmSync(tmp, { recursive: true, force: true });
}

export function makeEntry(
	id: string,
	overrides: Partial<SwarmKnowledgeEntry> = {},
): SwarmKnowledgeEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson for ${id}`,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: new Date().toISOString(),
				project_name: 'issue-1717-test',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		project_name: 'issue-1717-test',
		...overrides,
	};
}

export async function writeSwarmKnowledge(
	tmp: string,
	entries: SwarmKnowledgeEntry[],
): Promise<string> {
	const swarmPath = resolveSwarmKnowledgePath(tmp);
	await mkdir(path.dirname(swarmPath), { recursive: true });
	let contents = '';
	for (const e of entries) {
		contents += `${JSON.stringify(e)}\n`;
	}
	await writeFile(swarmPath, contents, 'utf-8');
	return swarmPath;
}

export async function readSwarmKnowledge(
	tmp: string,
): Promise<SwarmKnowledgeEntry[]> {
	const swarmPath = resolveSwarmKnowledgePath(tmp);
	if (!existsSync(swarmPath)) return [];
	return readKnowledge<SwarmKnowledgeEntry>(swarmPath);
}

export function makeCluster(
	overrides: Partial<KnowledgeCluster> = {},
): KnowledgeCluster {
	return {
		slug: 'issue-1717-skill',
		title: 'Issue 1717 Test Skill',
		entries: [],
		triggers: ['when test scenario'],
		required_actions: ['call declare_scope'],
		forbidden_actions: ['skip scope declaration'],
		target_agents: [],
		verification_checks: ['check scope is declared'],
		avgConfidence: 0.85,
		...overrides,
	};
}
