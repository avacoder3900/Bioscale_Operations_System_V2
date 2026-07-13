import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(302, '/login');
	}

	await connectDB();

	// Check Box.com + Particle connection status (non-critical)
	const [boxInteg, particleInteg] = await Promise.all([
		Integration.findOne({ type: 'box' }).lean().catch(() => null),
		Integration.findOne({ type: 'particle' }).lean().catch(() => null)
	]);

	const isBoxConnected = Boolean(boxInteg?.accessToken);

	let particleStatus: 'connected' | 'stale' | 'disconnected' = 'disconnected';
	if (particleInteg?.isActive) {
		const staleThreshold = ((particleInteg.syncIntervalMinutes as number) ?? 30) * 2 * 60 * 1000;
		if (particleInteg.lastSyncAt && Date.now() - new Date(particleInteg.lastSyncAt).getTime() < staleThreshold) {
			particleStatus = 'connected';
		} else {
			particleStatus = 'stale';
		}
	}

	const user = locals.user;
	const canAccessDocuments = hasPermission(user, 'document:read');
	const canAccessInventory = hasPermission(user, 'inventory:read');
	const canAccessCartridges = hasPermission(user, 'cartridge:read');
	const canAccessAssays = hasPermission(user, 'assay:read');
	const canAccessDevices = hasPermission(user, 'device:read');
	const canAccessSpu = hasPermission(user, 'spu:read');
	const canAccessTestResults = hasPermission(user, 'testResult:read');
	const canManageUsers = hasPermission(user, 'user:read');
	const canManageRoles = hasPermission(user, 'role:read');

	return {
		user,
		canAccessDocuments,
		canAccessInventory,
		canAccessCartridges,
		canAccessAssays,
		canAccessDevices,
		canAccessSpu,
		canAccessTestResults,
		canAccessAdmin: canManageUsers || canManageRoles,
		isBoxConnected,
		particleStatus
	};
};
