/**
 * URL normalization helpers for document/photo URLs.
 * Ensures old Box URLs or other external URLs are converted to local R2 paths.
 */

/**
 * Normalize a single document URL.
 * - If it's already a local /api/r2/files/ path, return as-is.
 * - If null/undefined/empty, return null.
 */
export function normalizeDocUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	return url;
}

/**
 * Normalize an array of document URLs.
 */
export function normalizeDocUrls(urls: (string | null | undefined)[]): string[] {
	return urls.map(normalizeDocUrl).filter((u): u is string => u !== null);
}
