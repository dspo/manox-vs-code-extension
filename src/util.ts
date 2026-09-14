// Small shared helpers.

/** Human text for a caught value: Error, RpcError-shaped rejection, or
 * anything else (never "[object Object]"). */
export function errorText(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (typeof e === 'object' && e !== null) {
		const message = (e as { message?: unknown }).message;
		if (typeof message === 'string' && message !== '') return message;
	}
	try {
		return String(e);
	} catch {
		return 'unknown error';
	}
}
