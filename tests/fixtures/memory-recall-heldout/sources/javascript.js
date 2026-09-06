export function loadUserProfile(userId) {
	return fetch(`/users/${userId}`);
}
