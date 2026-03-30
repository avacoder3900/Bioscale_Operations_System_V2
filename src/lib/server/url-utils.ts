export function normalizeDocUrl(url: string | null | undefined): string | null {
	if (!url) return null;
	if (url.startsWith('/api/')) return url;
	const boxMatch = url.match(/app\.box\.com\/files?\/(\d+)/);
	if (boxMatch) return `/api/box/files/${boxMatch[1]}/view`;
	return url;
}

export function normalizeDocUrls(urls: (string | null | undefined)[]): string[] {
	return urls.map(normalizeDocUrl).filter((u): u is string => u !== null);
}
