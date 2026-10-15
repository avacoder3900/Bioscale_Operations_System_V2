import { redirect } from '@sveltejs/kit';
import { hasPermission } from '$lib/server/permissions';
import { connectDB, Integration } from '$lib/server/db';
import type { LayoutServerLoad } from './$types';

// Public routes that don't require authentication
const PUBLIC_PATHS = ['/login', '/logout', '/invite', '/api'];

type IntegrationStatus = { isBoxConnected: boolean; particleStatus: 'connected' | 'stale' | 'disconnected' };

// The header's Box / Particle dots. Two reads that were re-run on every page
// change, in series, for a status that changes a few times a day — cached per
// process for a minute (perf, 2026-09-30). Failures fall back to "not
// connected", exactly as before, and are not cached.
const INTEGRATION_TTL_MS = 60_000;
let integrationCache: { at: number; value: IntegrationStatus } | null = null;

async function integrationStatus(): Promise<IntegrationStatus> {
	if (integrationCache && Date.now() - integrationCache.at < INTEGRATION_TTL_MS) return integrationCache.value;
	const value: IntegrationStatus = { isBoxConnected: false, particleStatus: 'disconnected' };
	let ok = true;
	try {
		const [boxInteg, particleInteg] = await Promise.all([
			Integration.findOne({ type: 'box' }).select('accessToken').lean(),
			Integration.findOne({ type: 'particle' }).select('isActive syncIntervalMinutes lastSyncAt').lean()
		]);
		value.isBoxConnected = Boolean(boxInteg?.accessToken);
		if (particleInteg?.isActive) {
			const staleThreshold = ((particleInteg.syncIntervalMinutes as number) ?? 30) * 2 * 60 * 1000;
			if (particleInteg.lastSyncAt && Date.now() - new Date(particleInteg.lastSyncAt).getTime() < staleThreshold) {
				value.particleStatus = 'connected';
			} else {
				value.particleStatus = 'stale';
			}
		}
	} catch {
		ok = false; // non-critical
	}
	if (ok) integrationCache = { at: Date.now(), value };
	return value;
}

export const load: LayoutServerLoad = async ({ locals, url, untrack }) => {
	// `untrack`: reading url.pathname here used to make SvelteKit re-run this
	// load on EVERY client-side navigation (it tracks url accesses), so each
	// page change paid the session lookups AND these queries again before the
	// page's own load could start. The public-path check only matters on a hard
	// load / invalidateAll — a client-side hop into a protected page already has
	// the user, and a login/logout redirect invalidates everything (perf, 2026-09-30).
	const pathname = untrack(() => url.pathname);
	if (PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + '/'))) {
		return {};
	}

	if (!locals.user) {
		redirect(302, '/login');
	}

	await connectDB();
	const { isBoxConnected, particleStatus } = await integrationStatus();

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
		user: JSON.parse(JSON.stringify(user)),
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
