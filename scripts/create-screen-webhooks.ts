/**
 * Create the five screen-pipeline Particle webhooks on product 32546, mirroring the existing
 * `blank-test` webhook (POST to the BIMS webhook endpoint, JSON with default fields,
 * x-agent-api-key header, default response topic). Idempotent: an event that already has a
 * webhook is skipped. Uses the Particle token stored in the Integration collection and
 * AGENT_API_KEY from .env. See docs/particle-webhooks-screen.md.
 *
 *   npx tsx scripts/create-screen-webhooks.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const PRODUCT = '32546';
// Particle matches webhook event names by PREFIX: the 'bioscale/screen' hook already
// forwards 'bioscale/screen_record', so a separate screen_record hook would POST every
// chunk twice (it did, 2026-10-15). Only 'bioscale/ping' needs a response topic — the
// device waits for the hook-response to time the round trip; hooks created through the
// API get NO response topic unless one is given (the first screen's three pings timed
// out for exactly that reason). The others must NOT have one: a hook-response per
// chunk would cost a data op each and spam "Unknown webhook response" in the device log.
const EVENTS = ['bioscale/screen', 'bioscale/ping', 'bioscale/mag_sweep_chunk', 'bioscale/sweep_progress'];
const RESPONSE_TOPIC = '{{{PARTICLE_DEVICE_ID}}}/hook-response/{{{PARTICLE_EVENT_NAME}}}';
const URL = 'https://bioscale-operations-system-mongodb.vercel.app/api/particle/webhook';

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const integ: any = await mongoose.connection.db!.collection('integrations').findOne({ type: 'particle' });
	await mongoose.disconnect();
	const token = integ?.accessToken ?? integ?.access_token ?? integ?.token;
	const apiKey = process.env.AGENT_API_KEY;
	if (!token || !apiKey) {
		console.log('missing Particle token (integrations type=particle) or AGENT_API_KEY in .env');
		return;
	}
	const headers = { Authorization: `Bearer ${token}` };
	const base = `https://api.particle.io/v1/products/${PRODUCT}/integrations`;
	const list: any = await (await fetch(base, { headers })).json();
	const existing = new Map((Array.isArray(list) ? list : list.integrations).map((w: any) => [w.event, w.id]));
	for (const event of EVENTS) {
		if (existing.has(event)) {
			console.log(`exists  ${event} -> ${existing.get(event)}`);
			continue;
		}
		const body = {
			integration_type: 'Webhook',
			event,
			url: URL,
			requestType: 'POST',
			json: true,
			noDefaults: false,
			headers: { 'x-agent-api-key': apiKey },
			...(event === 'bioscale/ping' ? { responseTopic: RESPONSE_TOPIC } : {})
		};
		const r = await fetch(base, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		const j: any = await r.json().catch(() => ({}));
		console.log(`${r.ok ? 'created' : 'FAILED '} ${event} -> ${j.id ?? j.error ?? JSON.stringify(j).slice(0, 200)}`);
	}
	const after: any = await (await fetch(base, { headers })).json();
	for (const w of Array.isArray(after) ? after : after.integrations) {
		if (!EVENTS.includes(w.event)) continue;
		console.log(JSON.stringify({ id: w.id, event: w.event, url: w.url, requestType: w.requestType, json: w.json, noDefaults: w.noDefaults, hasKeyHeader: !!w.headers?.['x-agent-api-key'], responseTopic: w.responseTopic }));
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
