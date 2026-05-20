/**
 * Derive plan identity string from plan object.
 * Canonical implementation — all consumers must import from here.
 */
export declare function derivePlanId(plan: {
    swarm: string;
    title: string;
}): string;
