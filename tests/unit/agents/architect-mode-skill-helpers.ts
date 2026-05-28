import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readSkill(slug: string): string {
	return readFileSync(
		join(process.cwd(), '.opencode/skills', slug, 'SKILL.md'),
		'utf-8',
	);
}

export const PLAN_PROTOCOL = readSkill('plan');
export const EXECUTE_PROTOCOL = readSkill('execute');
export const PHASE_WRAP_PROTOCOL = readSkill('phase-wrap');

const MODE_PROTOCOL_INSERTIONS = [
	{
		nextMarker: '### MODE: SPECIFY',
		protocol: readSkill('brainstorm'),
	},
	{
		nextMarker: '### MODE: CLARIFY-SPEC',
		protocol: readSkill('specify'),
	},
	{
		nextMarker: '### MODE: RESUME',
		protocol: readSkill('clarify-spec'),
	},
	{
		nextMarker: '### MODE: CLARIFY',
		protocol: readSkill('resume'),
	},
	{
		nextMarker: '### MODE: DISCOVER',
		protocol: readSkill('clarify'),
	},
	{
		nextMarker: '### MODE: CONSULT',
		protocol: readSkill('discover'),
	},
	{
		nextMarker: '### MODE: PRE-PHASE BRIEFING',
		protocol: readSkill('consult'),
	},
	{
		nextMarker: '### MODE: COUNCIL',
		protocol: readSkill('pre-phase-briefing'),
	},
	{
		nextMarker: '### MODE: DEEP_DIVE',
		protocol: readSkill('council'),
	},
	{
		nextMarker: '### MODE: PLAN',
		protocol: readSkill('issue-ingest'),
	},
	{
		nextMarker: '### MODE: CRITIC-GATE',
		protocol: PLAN_PROTOCOL,
	},
	{
		nextMarker: '### MODE: EXECUTE',
		protocol: readSkill('critic-gate'),
	},
	{
		nextMarker: '## ⛔ RETROSPECTIVE GATE',
		protocol: EXECUTE_PROTOCOL,
	},
	{
		nextMarker: '## FILES',
		protocol: PHASE_WRAP_PROTOCOL,
	},
] as const;

export const EXTRACTED_MODE_PROTOCOLS = MODE_PROTOCOL_INSERTIONS.map(
	({ protocol }) => protocol,
).join('\n');

export function withExtractedModeProtocols(prompt: string): string {
	let result = prompt;

	for (const { nextMarker, protocol } of MODE_PROTOCOL_INSERTIONS) {
		if (result.includes(nextMarker) && !result.includes(protocol)) {
			result = result.replace(nextMarker, `${protocol}\n${nextMarker}`);
		}
	}

	return result;
}

export function getExtractedExecuteSection(prompt: string): string {
	const start = prompt.indexOf('### MODE: EXECUTE');
	const end = prompt.indexOf('### MODE: PHASE-WRAP', start);
	const stub =
		start === -1 ? '' : prompt.slice(start, end === -1 ? undefined : end);
	return `${stub}\n${EXECUTE_PROTOCOL}`;
}
