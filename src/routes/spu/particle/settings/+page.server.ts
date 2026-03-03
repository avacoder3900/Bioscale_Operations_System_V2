import { fail } from '@sveltejs/kit';
import { connectDB, Integration, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { testConnection, syncDevices } from '$lib/server/particle';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const integ = await Integration.findOne({ type: 'particle' }).lean() as any;

	return {
		hasToken: Boolean(integ?.accessToken),
		isActive: Boolean(integ?.isActive),
		organizationSlug: integ?.organizationSlug ?? null,
		lastSyncAt: integ?.lastSyncAt ?? null,
		lastSyncStatus: integ?.lastSyncStatus ?? null,
		lastSyncError: integ?.lastSyncError ?? null
	};
};

export const actions: Actions = {
	saveToken: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const accessToken = form.get('accessToken')?.toString()?.trim();
		if (!accessToken) return fail(400, { error: 'Access token is required' });

		// Verify the token works before saving
		try {
			await testConnection(accessToken);
		} catch (err) {
			return fail(400, { error: `Invalid token: ${err instanceof Error ? err.message : String(err)}` });
		}

		// Upsert integration record
		const existing = await Integration.findOne({ type: 'particle' }).lean() as any;
		if (existing) {
			await Integration.updateOne(
				{ _id: existing._id },
				{ $set: { accessToken, isActive: true } }
			);
		} else {
			await Integration.create({
				_id: generateId(),
				type: 'particle',
				accessToken,
				isActive: true,
				syncIntervalMinutes: 30
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'integrations',
			recordId: existing?._id ?? 'new',
			action: existing ? 'UPDATE' : 'INSERT',
			newData: { type: 'particle', hasToken: true },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true, message: 'Particle access token saved and verified.' };
	},

	testConnection: async ({ locals }) => {
		requirePermission(locals.user, 'spu:read');
		await connectDB();

		const integ = await Integration.findOne({ type: 'particle' }).lean() as any;
		if (!integ?.accessToken) return fail(400, { error: 'No access token configured' });

		try {
			const result = await testConnection(integ.accessToken);
			return { success: true, message: `Connection OK — ${result.deviceCount} device(s) found.` };
		} catch (err) {
			return fail(400, { error: `Connection failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	},

	syncNow: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		// Mark in-progress
		await Integration.updateOne(
			{ type: 'particle' },
			{ $set: { lastSyncStatus: 'in_progress' } }
		);

		try {
			const result = await syncDevices();
			if (result.errors.length) {
				return { success: true, message: `Synced ${result.synced} device(s) with ${result.errors.length} error(s).` };
			}
			return { success: true, message: `Successfully synced ${result.synced} device(s).` };
		} catch (err) {
			await Integration.updateOne(
				{ type: 'particle' },
				{ $set: { lastSyncStatus: 'error', lastSyncError: err instanceof Error ? err.message : String(err) } }
			);
			return fail(400, { error: `Sync failed: ${err instanceof Error ? err.message : String(err)}` });
		}
	},

	disconnect: async ({ locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		await Integration.updateOne(
			{ type: 'particle' },
			{ $set: { accessToken: null, isActive: false } }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'integrations',
			recordId: 'particle',
			action: 'UPDATE',
			newData: { type: 'particle', disconnected: true },
			changedBy: locals.user!.username ?? locals.user!._id
		});

		return { success: true, message: 'Particle integration disconnected.' };
	}
};
