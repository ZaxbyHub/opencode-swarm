export function validPort(port: number): boolean {
	return port >= 1 && port <= 65_535;
}
