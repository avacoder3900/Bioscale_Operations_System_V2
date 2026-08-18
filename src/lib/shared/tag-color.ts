/**
 * KB2-16 — deterministic tag → color mapping. Projects (and their stored
 * colors) are gone; anywhere the UI used project color for visual grouping it
 * now hashes a tag (or task id) into this fixed palette. Client-safe.
 */
export const TAG_PALETTE = [
	'#22d3ee',
	'#a78bfa',
	'#f59e0b',
	'#10b981',
	'#f472b6',
	'#818cf8',
	'#fb923c',
	'#34d399'
] as const;

export function tagColor(key: string | null | undefined): string {
	if (!key) return '#6b7280';
	let h = 0;
	for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
	return TAG_PALETTE[h % TAG_PALETTE.length];
}
