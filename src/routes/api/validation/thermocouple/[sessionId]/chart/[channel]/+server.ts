import { json } from '@sveltejs/kit';
import { connectDB, ValidationSession } from '$lib/server/db';
import type { RequestHandler } from './$types';

const VALID_CHANNELS = ['ch1', 'ch2', 'ch3', 'ch4'];

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const { sessionId, channel } = params;
	if (!VALID_CHANNELS.includes(channel)) {
		return json({ error: `Invalid channel: ${channel}. Must be one of: ${VALID_CHANNELS.join(', ')}` }, { status: 400 });
	}

	await connectDB();
	const session = await ValidationSession.findById(sessionId).lean() as any;
	if (!session) return json({ error: 'Session not found' }, { status: 404 });

	const thermoResult = session.results?.find((r: any) => r.testType === 'thermocouple');
	const chartPng = thermoResult?.processedData?.channels?.[channel]?.chartPng;

	if (!chartPng) {
		return json({ error: 'Chart not found for this channel' }, { status: 404 });
	}

	const buffer = Buffer.from(chartPng, 'base64');
	return new Response(buffer, {
		headers: {
			'Content-Type': 'image/png',
			'Content-Length': String(buffer.length),
			'Cache-Control': 'public, max-age=86400'
		}
	});
};
