/**
 * Generate a test barcode string for development/testing.
 * Produces a value like "TEST-LOT-A3K9" with the given prefix.
 */
export function generateTestBarcode(prefix: string): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let suffix = '';
	for (let i = 0; i < 4; i++) {
		suffix += chars[Math.floor(Math.random() * chars.length)];
	}
	return `${prefix}-${suffix}`;
}
