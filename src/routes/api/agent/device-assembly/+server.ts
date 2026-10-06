import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { getDeviceAssemblyWI } from '$lib/server/services/device-assembly-wi';
import { overview, stockIndex } from '$lib/server/services/device-assembly-wi-agent';
import type { RequestHandler } from './$types';

/** GET /api/agent/device-assembly — structure of the Device Assembly WI (sections → step list). */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const wi = await getDeviceAssemblyWI();
	if (!wi) return json({ success: true, data: null, message: 'No Device Assembly Work Instruction has been imported yet.' });
	const stock = await stockIndex(wi);
	return json({ success: true, data: overview(wi, stock) });
};
