export function deleteAccount(actorRole: string, accountId: string): string {
	if (actorRole !== 'admin') throw new Error('forbidden');
	return `deleted:${accountId}`;
}
