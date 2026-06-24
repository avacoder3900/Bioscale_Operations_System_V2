/**
 * POST /api/cv/stations/[id]/takeover — admin-authorized station takeover.
 *
 * An operator clicks "Connect" on a station another operator (or a dead browser
 * tab, since the lock has no TTL) is holding. They supply an admin/manager
 * account's username + password; we bcrypt-verify it and confirm that account
 * is allowed to manage CV stations, then boot the current holder and claim the
 * lock for the requesting operator in a single update so no one can slip into
 * the gap. The booted operator and authorizing admin are both audited.
 *
 * Authorization is by permission, not a role string — this schema stores
 * roles[].permissions[]; there is no User.role field.
 */
import { json, error } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
import { AuditLog } from '$lib/server/db/models/audit-log.js';
import { User } from '$lib/server/db/models/user.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasAnyPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const TAKEOVER_PERMISSIONS = ['admin:full', 'cv:write', 'manufacturing:write'];

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	await connectDB();

	let body: { adminUsername?: string; adminPassword?: string };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid request body' }, { status: 400 });
	}
	const adminUsername = (body.adminUsername ?? '').trim();
	const adminPassword = body.adminPassword ?? '';
	if (!adminUsername || !adminPassword) {
		return json({ error: 'Admin username and password are required' }, { status: 400 });
	}

	// Verify the authorizing admin account: bcrypt-compare the supplied password,
	// confirm the account is active, and confirm it can manage CV stations.
	const adminUser = (await User.findOne({ username: adminUsername }).lean()) as any;
	if (!adminUser?.passwordHash) {
		return json({ error: 'Invalid admin credentials' }, { status: 403 });
	}
	const validPassword = await bcrypt.compare(adminPassword, adminUser.passwordHash);
	if (!validPassword) {
		return json({ error: 'Invalid admin credentials' }, { status: 403 });
	}
	if (adminUser.isActive === false) {
		return json({ error: 'That admin account is deactivated' }, { status: 403 });
	}
	if (!hasAnyPermission(adminUser, TAKEOVER_PERMISSIONS)) {
		return json(
			{ error: 'That account is not authorized to take over a station' },
			{ status: 403 }
		);
	}

	const station = (await CaptureStation.findById(params.id)
		.select('currentOperator')
		.lean()) as any;
	if (!station) return json({ error: 'Station not found' }, { status: 404 });

	const previousHolder = station.currentOperator ?? null;
	const since = new Date();
	const newOperator = { _id: locals.user._id, username: locals.user.username, since };

	await CaptureStation.updateOne(
		{ _id: params.id },
		{ $set: { currentOperator: newOperator } }
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'capture_stations',
		recordId: params.id,
		action: 'UPDATE',
		oldData: { currentOperator: previousHolder },
		newData: { currentOperator: newOperator, authorizedBy: adminUser.username },
		changedFields: ['currentOperator'],
		changedAt: since,
		changedBy: locals.user.username,
		reason: 'admin-takeover'
	});

	return json({ ok: true, bootedOperator: previousHolder?.username ?? null });
};
