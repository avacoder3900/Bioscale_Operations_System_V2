// TODO: Box.com integration deferred
import { connectDB, Integration } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	await connectDB();

	let isConnected = false;
	try {
		const boxInteg = await Integration.findOne({ type: 'box' }).lean();
		isConnected = Boolean(boxInteg?.accessToken);
	} catch { /* non-critical */ }

	return {
		isConnected,
		files: [] // TODO: Box.com integration deferred
	};
};
