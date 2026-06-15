/**
 * BIMS custom-labware library (LABWARE-LIBRARY-AUTO-BUNDLE).
 * GET    /api/opentrons-lab/labware            — list definitions
 * POST   /api/opentrons-lab/labware            — upload a .json definition (multipart: labwareFile)
 * DELETE /api/opentrons-lab/labware?namespace=&loadName=&version=
 *
 * Definitions stored here are bundled with every protocol upload to a robot
 * (see proxy.robotUploadProtocol) so the OT-2 resolves custom labware at run time.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, LabwareDefinition, AuditLog, generateId } from '$lib/server/db';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();
	const defs = await LabwareDefinition.find()
		.select('namespace loadName version displayName category fileName uploadedBy updatedAt')
		.sort({ loadName: 1 }).lean();
	return json({ data: JSON.parse(JSON.stringify(defs)) });
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const fd = await request.formData();
	const file = fd.get('labwareFile') as File | null;
	if (!file) error(400, 'labwareFile is required');

	let def: any;
	try { def = JSON.parse(await file.text()); } catch { error(400, 'File is not valid JSON'); }

	const namespace = def?.namespace;
	const loadName = def?.parameters?.loadName;
	const version = Number(def?.version ?? 1);
	if (!namespace || !loadName) {
		error(400, 'Not an Opentrons labware definition (missing namespace or parameters.loadName)');
	}
	const displayName = def?.metadata?.displayName ?? loadName;
	const category = def?.metadata?.displayCategory ?? 'Other';

	await LabwareDefinition.findOneAndUpdate(
		{ namespace, loadName, version },
		{
			$set: { displayName, category, fileName: file.name, definition: def, uploadedBy: locals.user.username },
			$setOnInsert: { _id: generateId() }
		},
		{ upsert: true, new: true }
	);

	await AuditLog.create({
		_id: generateId(),
		action: 'upload',
		resourceType: 'labware_definition',
		resourceId: `${namespace}/${loadName}/${version}`,
		userId: locals.user._id,
		username: locals.user.username,
		timestamp: new Date(),
		details: { namespace, loadName, version, displayName }
	});

	return json({ data: { namespace, loadName, version, displayName } }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const namespace = url.searchParams.get('namespace');
	const loadName = url.searchParams.get('loadName');
	const version = Number(url.searchParams.get('version') ?? 1);
	if (!namespace || !loadName) error(400, 'namespace and loadName are required');

	const res = await LabwareDefinition.deleteOne({ namespace, loadName, version });
	await AuditLog.create({
		_id: generateId(),
		action: 'delete',
		resourceType: 'labware_definition',
		resourceId: `${namespace}/${loadName}/${version}`,
		userId: locals.user._id,
		username: locals.user.username,
		timestamp: new Date(),
		details: { deleted: res.deletedCount }
	});
	return json({ data: { deleted: res.deletedCount } });
};
