import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ locals, url }) => {
	// Public routes that don't require authentication
	const publicPaths = ['/login', '/logout', '/invite', '/api'];
	if (publicPaths.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))) {
		return {};
	}

	if (!locals.user) {
		redirect(302, '/login');
	}

	await connectDB();

	// Check Box.com connection status
	let isBoxConnected = false;
	try {
		const boxInteg = await Integration.findOne({ type: 'box' }).lean();
		isBoxConnected = Boolean(boxInteg?.accessToken);
	} catch { /* non-critical */ }

	// Check Particle connection status
	let particleStatus: 'connected' | 'stale' | 'disconnected' = 'disconnected';
	try {
		const particleInteg = await Integration.findOne({ type: 'particle' }).lean();
		if (particleInteg?.isActive) {
			const staleThreshold = ((particleInteg.syncIntervalMinutes as number) ?? 30) * 2 * 60 * 1000;
			if (particleInteg.lastSyncAt && Date.now() - new Date(particleInteg.lastSyncAt).getTime() < staleThreshold) {
				particleStatus = 'connected';
			} else {
				particleStatus = 'stale';
			}
		}
	} catch { /* non-critical */ }

	const user = locals.user;
	const canAccessDocuments = hasPermission(user, 'document:read');
	const canAccessInventory = hasPermission(user, 'inventory:read');
	const canAccessCartridges = hasPermission(user, 'cartridge:read');
	const canAccessAssays = hasPermission(user, 'assay:read');
	const canAccessDevices = hasPermission(user, 'device:read');
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
		canAccessTestResults,
		canAccessAdmin: canManageUsers || canManageRoles,
		isBoxConnected,
		particleStatus
	};
};

export const config = { maxDuration: 60 };
