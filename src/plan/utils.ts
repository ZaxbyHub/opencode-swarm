/**
 * Derive plan identity string from plan object.
 * Canonical implementation — all consumers must import from here.
 */
export function derivePlanId(plan: { swarm: string; title: string }): string {
	return `${plan.swarm}-${plan.title}`.replace(/[^a-zA-Z0-9-_]/g, '_');
}
