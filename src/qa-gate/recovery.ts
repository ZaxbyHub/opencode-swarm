export interface QaGateRecoveryIdentity {
	swarm: string;
	title: string;
}

export function formatLegacyQaBindingOnlyCall(
	identity: QaGateRecoveryIdentity,
): string {
	return `set_qa_gates({ swarm_id: ${JSON.stringify(identity.swarm)}, plan_title: ${JSON.stringify(identity.title)}, adopt_legacy_binding_only: true })`;
}

export function formatLegacyQaBindingRecovery(
	identity: QaGateRecoveryIdentity,
	retryAction: string,
): string {
	return `Run ${formatLegacyQaBindingOnlyCall(identity)} from the current persisted plan identity to exact-bind the existing QA profile without changing gates or its lock, then ${retryAction}.`;
}
