import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { getDeviceAssemblyWI } from '$lib/server/services/device-assembly-wi';
import { getRecentPulls } from '$lib/server/services/device-assembly-wi-pulls';
import type { RequestHandler } from './$types';

/** GET /api/agent/device-assembly/pulls?limit=&section=&step=&part=&user=&serial= — material pull ledger. */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const wi = await getDeviceAssemblyWI();
	if (!wi) return json({ success: true, data: [], message: 'No SPU Assembly Work Instruction has been imported yet.' });
	let rows = await getRecentPulls(wi._id, 500);
	const section = url.searchParams.get('section');
	const step = url.searchParams.get('step');
	const part = url.searchParams.get('part')?.toLowerCase();
	const user = url.searchParams.get('user')?.toLowerCase();
	const serial = url.searchParams.get('serial')?.toLowerCase();
	if (section != null && section !== '') rows = rows.filter((p) => String(p.sectionNumber) === String(section).replace(/\D/g, ''));
	if (step) rows = rows.filter((p) => String(p.stepNumber) === step);
	if (part) rows = rows.filter((p) => (p.partNumber ?? '').toLowerCase().includes(part) || (p.name ?? '').toLowerCase().includes(part));
	if (user) rows = rows.filter((p) => (p.performedBy?.username ?? '').toLowerCase() === user);
	if (serial) rows = rows.filter((p) => (p.deviceSerial ?? '').toLowerCase().includes(serial));
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)));
	return json({
		success: true,
		data: rows.slice(0, limit).map((p) => ({
			pullId: p._id, when: p.performedAt, by: p.performedBy?.username ?? null,
			section: p.sectionNumber === 0 ? 'Setup' : `Sub-Assembly ${p.sectionNumber}`, stepNumber: p.stepNumber, wiVersion: p.wiVersion,
			partNumber: p.partNumber, name: p.name, quantity: p.quantity, unit: p.unit, unitsBuilt: p.unitsBuilt,
			stockBefore: p.previousQuantity, stockAfter: p.newQuantity, deviceSerial: p.deviceSerial, notes: p.notes || undefined,
			inventoryTransactionId: p.inventoryTransactionId
		}))
	});
};
