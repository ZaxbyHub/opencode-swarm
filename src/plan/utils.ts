/**
 * Derive plan identity string from plan object.
 * Canonical implementation — all consumers must import from here.
 */
import { createHash } from 'node:crypto';

export function derivePlanId(plan: { swarm: string; title: string }): string {
	return `${plan.swarm}-${plan.title}`.replace(/[^a-zA-Z0-9-_]/g, '_');
}

/**
 * Collision-resistant binding for security-sensitive evidence that also stores
 * the readable legacy plan_id. This preserves existing plan_id compatibility
 * while giving gates a stable raw swarm/title fingerprint to compare.
 */
export function derivePlanIdentityHash(plan: {
	swarm: string;
	title: string;
}): string {
	return createHash('sha256')
		.update(JSON.stringify([plan.swarm, plan.title]), 'utf8')
		.digest('hex');
}
