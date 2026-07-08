import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QA_GATE_PIPELINE_STEP_COUNT } from '../src/config/qa-gate-pipeline';

type DriftSeverity = 'error' | 'warning' | 'notice';

interface DriftFinding {
	category: string;
	severity: DriftSeverity;
	message: string;
	file?: string;
}

interface DocsNumericClaim {
	readonly file: string;
	readonly label: string;
	readonly regex: RegExp;
	readonly expected: number;
}

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'..',
);

const DOCS_NUMERIC_CLAIMS = [
	{
		file: 'docs/planning.md',
		label: 'planning QA gate count',
		regex: /full\s+(\d+)-step\s+QA gate/i,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
	},
	{
		file: 'docs/swarm-briefing.md',
		label: 'briefing QA gate count',
		regex: /a\s+(\d+)-step\s+QA\s+gate/i,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
	},
	{
		file: 'docs/swarm-briefing.md',
		label: 'briefing pipeline heading count',
		regex: /## Pipeline \((\d+) Steps\)/,
		expected: QA_GATE_PIPELINE_STEP_COUNT,
	},
] as const satisfies readonly DocsNumericClaim[];

export function detectDocsClaimDrift(root: string = REPO_ROOT): DriftFinding[] {
	const findings: DriftFinding[] = [];
	const category = 'docs-claim';

	for (const claim of DOCS_NUMERIC_CLAIMS) {
		const absolutePath = path.join(root, claim.file);
		if (!fs.existsSync(absolutePath)) {
			findings.push({
				category,
				severity: 'error',
				file: claim.file,
				message: `${claim.label} file is missing`,
			});
			continue;
		}
		const match = claim.regex.exec(fs.readFileSync(absolutePath, 'utf-8'));
		if (!match?.[1]) {
			findings.push({
				category,
				severity: 'warning',
				file: claim.file,
				message: `${claim.label} is missing numeric claim matching ${claim.regex}`,
			});
			continue;
		}
		const actual = Number(match[1]);
		if (actual !== claim.expected) {
			findings.push({
				category,
				severity: 'warning',
				file: claim.file,
				message: `${claim.label} says ${actual}, but QA_GATE_PIPELINE_STEPS has ${claim.expected}`,
			});
		}
	}

	return findings;
}
