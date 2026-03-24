import { connectDB, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();
	const robots = await OpentronsRobot.find({ isActive: true }).lean();

	// Aggregate labware from all protocols across all robots
	const labwareMap = new Map<string, { displayName: string; category: string; count: number }>();

	for (const robot of robots) {
		for (const proto of (robot as any).protocols ?? []) {
			const defs = proto.labwareDefinitions;
			if (defs && typeof defs === 'object') {
				for (const [loadName, def] of Object.entries(defs) as any[]) {
					const existing = labwareMap.get(loadName);
					if (existing) {
						existing.count++;
					} else {
						const displayName = def?.metadata?.displayName ?? loadName;
						const cat = def?.metadata?.displayCategory ?? 'Other';
						labwareMap.set(loadName, { displayName, category: cat, count: 1 });
					}
				}
			}
		}
	}

	return {
		labware: Array.from(labwareMap.entries()).map(([loadName, data]) => ({
			loadName,
			displayName: data.displayName,
			category: data.category,
			count: data.count
		})),
		robots: robots.map((r: any) => ({
			robotId: r._id,
			name: r.name ?? '',
			ip: r.ip ?? '',
			lastHealthOk: r.lastHealthOk ?? false
		}))
	};
};
