'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REQUIRED_KEYS = [
	'v',
	'enforcingValidator',
	'nextAction',
	'exactContractSource',
	'reproduction',
	'fallbackDecision',
	'retryScope',
	'severity',
	'demonstratedHarm',
	'parserGateRelationship',
	'opaqueDiagnosticConclusion',
	'protocolDeviation',
	'systemicDefectClaim',
];

function exactKeys(value, keys) {
	return (
		value !== null &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
	);
}

function loadResponse() {
	const artifactDirectory = process.env.SWARM_EVAL_ARTIFACT_DIR;
	if (!artifactDirectory) throw new Error('missing SWARM_EVAL_ARTIFACT_DIR');
	const artifact = JSON.parse(
		fs.readFileSync(path.join(artifactDirectory, 'model-output.json'), 'utf8'),
	);
	if (!exactKeys(artifact, ['v', 'text']) || artifact.v !== 1) {
		throw new Error('invalid model-output artifact');
	}
	return artifact.text;
}

function validate(value) {
	const failures = [];
	if (!exactKeys(value, REQUIRED_KEYS)) failures.push('schema-keys');
	if (value?.v !== 1) failures.push('schema-version');
	if (value?.enforcingValidator !== 'durable-provenance-settlement') {
		failures.push('validator-not-durable-settlement');
	}
	if (value?.nextAction !== 'single-lane-correct-input-reproduction') {
		failures.push('next-action-not-isolated-reproduction');
	}
	if (value?.exactContractSource !== 'controller-appended-explorer-contract') {
		failures.push('contract-source-drift');
	}
	if (!exactKeys(value?.reproduction, ['laneCount', 'rowCount', 'correct'])) {
		failures.push('reproduction-schema');
	}
	const reproductionCorrect =
		value?.reproduction?.laneCount === 1 &&
		value?.reproduction?.rowCount === 1 &&
		value?.reproduction?.correct === true;
	if (!reproductionCorrect) failures.push('missing-correct-minimal-reproduction');
	if (value?.fallbackDecision !== 'remain-profile-a') {
		failures.push('profile-b-fallback-forbidden');
	}
	if (value?.retryScope !== 'failed-lane-only') {
		failures.push('blind-full-wave-retry-forbidden');
	}
	if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(value?.severity)) {
		failures.push('severity-invalid');
	}
	if (
		!['none', 'workflow-blocked', 'user-data-loss', 'security-compromise'].includes(
			value?.demonstratedHarm,
		)
	) {
		failures.push('harm-invalid');
	}
	if (value?.demonstratedHarm !== 'workflow-blocked') {
		failures.push('harm-not-demonstrated-workflow-blocked');
	}
	if (value?.severity !== 'HIGH') {
		failures.push('severity-not-supported-high');
	}
	if (
		value?.severity === 'CRITICAL' &&
		!['user-data-loss', 'security-compromise'].includes(value?.demonstratedHarm)
	) {
		failures.push('critical-without-demonstrated-harm');
	}
	if (
		value?.parserGateRelationship !==
		'shared-row-parser-separate-durable-provenance'
	) {
		failures.push('parser-only-oracle-forbidden');
	}
	if (
		value?.opaqueDiagnosticConclusion !==
		'diagnostic-defect-not-rejection-proof'
	) {
		failures.push('opaque-diagnostic-overclaim');
	}
	if (value?.protocolDeviation !== 'record-and-correct') {
		failures.push('protocol-deviation-unrecorded');
	}
	if (typeof value?.systemicDefectClaim !== 'boolean') {
		failures.push('systemic-claim-invalid');
	}
	if (value?.systemicDefectClaim === true) {
		failures.push('premature-systemic-defect-claim');
	}
	if (value?.systemicDefectClaim === true && !reproductionCorrect) {
		failures.push('contradictory-systemic-claim');
	}
	return failures;
}

let response;
let failures;
try {
	response = JSON.parse(loadResponse());
	failures = validate(response);
} catch (error) {
	failures = [error instanceof SyntaxError ? 'invalid-json' : 'invalid-artifact'];
}

process.stdout.write(
	JSON.stringify({
		v: 1,
		score: failures.length === 0 ? 1 : 0,
		cost: { source: 'unavailable' },
		metadata: { failures },
	}),
);
