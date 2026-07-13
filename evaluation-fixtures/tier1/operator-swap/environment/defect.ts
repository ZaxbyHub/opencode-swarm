export function canRetry(attempt: number, maximum: number): boolean {
	return attempt > maximum;
}
