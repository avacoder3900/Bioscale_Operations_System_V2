import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, LabCartridge, CartridgeGroup } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const now = new Date();
	const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
	const in60 = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
	const in90 = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);

	const [allCartridges, groups] = await Promise.all([
		LabCartridge.find({}, {
			status: 1, cartridgeType: 1, groupId: 1,
			expirationDate: 1, barcode: 1, lotNumber: 1,
			usageLog: { $slice: -1 }
		}).lean(),
		CartridgeGroup.find({}).lean()
	]);

	const cs = allCartridges as any[];
	const groupList = groups as any[];

	// Inventory stats
	const total = cs.filter((c) => c.status !== 'disposed').length;
	const available = cs.filter((c) => c.status === 'available').length;
	const inUse = cs.filter((c) => c.status === 'in_use').length;
	const depleted = cs.filter((c) => c.status === 'depleted').length;
	const expired = cs.filter((c) => c.status === 'expired' || (c.expirationDate && new Date(c.expirationDate) < now && c.status !== 'disposed')).length;
	const quarantine = cs.filter((c) => c.status === 'quarantine').length;

	// By type
	const typeMap = new Map<string, number>();
	cs.forEach((c) => {
		if (c.status === 'disposed') return;
		const t = c.cartridgeType ?? 'unknown';
		typeMap.set(t, (typeMap.get(t) ?? 0) + 1);
	});
	const byType = [...typeMap.entries()].map(([cartridgeType, count]) => ({ cartridgeType, count }));

	// Expiration stats
	const expiredCount = cs.filter((c) => c.expirationDate && new Date(c.expirationDate) < now && c.status !== 'disposed').length;
	const within30 = cs.filter((c) => {
		if (!c.expirationDate || c.status === 'disposed') return false;
		const exp = new Date(c.expirationDate);
		return exp >= now && exp <= in30;
	}).length;
	const within60 = cs.filter((c) => {
		if (!c.expirationDate || c.status === 'disposed') return false;
		const exp = new Date(c.expirationDate);
		return exp > in30 && exp <= in60;
	}).length;
	const within90 = cs.filter((c) => {
		if (!c.expirationDate || c.status === 'disposed') return false;
		const exp = new Date(c.expirationDate);
		return exp > in60 && exp <= in90;
	}).length;

	const expiringSoon = cs
		.filter((c) => c.expirationDate && new Date(c.expirationDate) <= in30 && new Date(c.expirationDate) >= now && c.status !== 'disposed')
		.slice(0, 10)
		.map((c) => ({
			id: c._id,
			barcode: c.barcode ?? '',
			lotNumber: c.lotNumber ?? '',
			expirationDate: c.expirationDate
		}));

	// Usage stats
	const usageLogEntries = cs.flatMap((c) => c.usageLog ?? []);
	const totalActions = usageLogEntries.length;
	const userMap = new Map<string, number>();
	usageLogEntries.forEach((entry: any) => {
		const username = entry.performedBy?.username;
		if (username) userMap.set(username, (userMap.get(username) ?? 0) + 1);
	});
	const activeUsers = [...userMap.entries()]
		.sort(([, a], [, b]) => b - a)
		.slice(0, 10)
		.map(([username, actionCount]) => ({ username, actionCount }));

	// Group breakdown
	const groupMap = new Map(groupList.map((g: any) => [g._id, g]));
	const groupCartridges = new Map<string, any[]>();
	cs.forEach((c) => {
		if (c.groupId) {
			const arr = groupCartridges.get(c.groupId) ?? [];
			arr.push(c);
			groupCartridges.set(c.groupId, arr);
		}
	});

	const groupStats = groupList.map((g: any) => {
		const gcs = groupCartridges.get(g._id) ?? [];
		return {
			groupId: g._id,
			groupName: g.name ?? '',
			groupColor: g.color ?? null,
			total: gcs.length,
			available: gcs.filter((c) => c.status === 'available').length,
			inUse: gcs.filter((c) => c.status === 'in_use').length,
			depleted: gcs.filter((c) => c.status === 'depleted').length
		};
	});

	return {
		inventory: { total, available, inUse, depleted, expired, quarantine, byType },
		expiration: { expired: expiredCount, within30, within60, within90, expiringSoon },
		usage: { totalActions, activeUsers },
		groups: groupStats
	};
};
