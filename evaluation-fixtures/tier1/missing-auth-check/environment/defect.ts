export function deleteAccount(_actorRole: string, accountId: string): string {
	return `deleted:${accountId}`;
}
