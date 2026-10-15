/**
 * Chunked device uploads: store, track, assemble.
 *
 * Firmware envelope (brevitest-firmware.ino try_upload_sweep, reused by the
 * v102 screen-record upload): "<id>|<seq>|<total>|<slice>", seq 0-based.
 * The event is published BINARY, so the Particle webhook delivers `data` as
 * "data:application/octet-stream;base64,…" — decoded here to the envelope
 * text. A chunk may also arrive as plain text (a string publish); both are
 * accepted.
 *
 * Nothing is acknowledged to the device and nothing is retried from here: a
 * job that stays 'receiving' with holes is visible on the screen/mag pages so
 * an operator can run the upload again. Duplicate deliveries are upserts.
 */
import { DeviceChunk, DeviceChunkJob, Spu, generateId, type DeviceChunkKind } from '$lib/server/db';

const DATA_URL = 'data:application/octet-stream;base64,';

export interface ChunkEnvelope {
	id: string;
	seq: number;
	total: number;
	payload: string;
}

/** Split the envelope off a chunk event's data. Null when it is not a chunk. */
export function parseChunkEnvelope(data: unknown): ChunkEnvelope | null {
	if (typeof data !== 'string' || !data.length) return null;
	let text = data;
	if (data.startsWith(DATA_URL)) {
		try {
			text = Buffer.from(data.slice(DATA_URL.length), 'base64').toString('latin1');
		} catch {
			return null;
		}
	}
	const a = text.indexOf('|');
	if (a <= 0) return null;
	const b = text.indexOf('|', a + 1);
	if (b < 0) return null;
	const c = text.indexOf('|', b + 1);
	if (c < 0) return null;
	const id = text.slice(0, a).trim();
	const seq = Number(text.slice(a + 1, b));
	const total = Number(text.slice(b + 1, c));
	if (!id || !Number.isInteger(seq) || !Number.isInteger(total) || seq < 0 || total <= 0 || seq >= total) return null;
	return { id, seq, total, payload: text.slice(c + 1) };
}

export interface StoredChunkResult {
	jobId: string;
	complete: boolean;
	received: number;
	total: number;
	missing: number[];
}

/** Upsert one chunk and update its job. Returns whether the job is now complete. */
export async function storeChunk(
	particleDeviceId: string,
	kind: DeviceChunkKind,
	env: ChunkEnvelope,
	publishedAt: Date | null
): Promise<StoredChunkResult> {
	const now = new Date();
	await DeviceChunk.updateOne(
		{ particleDeviceId, kind, chunkId: env.id, seq: env.seq },
		{
			$setOnInsert: { _id: generateId(), receivedAt: now },
			$set: { total: env.total, data: env.payload, bytes: env.payload.length, publishedAt }
		},
		{ upsert: true }
	);
	const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': particleDeviceId }).select('_id udi').lean()) as any;
	const job = await DeviceChunkJob.findOneAndUpdate(
		{ particleDeviceId, kind, chunkId: env.id },
		{
			$setOnInsert: { _id: generateId(), firstChunkAt: now, status: 'receiving', spuId: spu?._id ?? null, spuUdi: spu?.udi ?? null },
			$set: { total: env.total, lastChunkAt: now },
			$addToSet: { received: env.seq }
		},
		{ upsert: true, new: true }
	).lean() as any;
	const received: number[] = job.received ?? [];
	const missing: number[] = [];
	for (let i = 0; i < env.total; i++) if (!received.includes(i)) missing.push(i);
	return { jobId: job._id, complete: missing.length === 0, received: received.length, total: env.total, missing };
}

/** Concatenate a complete job's chunks in seq order. Null when a chunk is missing. */
export async function assembleChunks(particleDeviceId: string, kind: DeviceChunkKind, chunkId: string): Promise<string | null> {
	const chunks = (await DeviceChunk.find({ particleDeviceId, kind, chunkId }).select('seq total data').sort({ seq: 1 }).lean()) as any[];
	if (!chunks.length) return null;
	const total = chunks[0].total as number;
	if (chunks.length !== total) return null;
	for (let i = 0; i < total; i++) if (chunks[i].seq !== i) return null;
	return chunks.map((c) => c.data as string).join('');
}

export async function markJob(
	particleDeviceId: string,
	kind: DeviceChunkKind,
	chunkId: string,
	patch: { status?: 'receiving' | 'assembled' | 'failed'; sessionId?: string | null; lastError?: string | null; assembledAt?: Date | null }
): Promise<void> {
	await DeviceChunkJob.updateOne({ particleDeviceId, kind, chunkId }, { $set: patch });
}

/** Live progress from `bioscale/sweep_progress` {"id","i","of"}. */
export async function recordProgress(particleDeviceId: string, kind: DeviceChunkKind, chunkId: string, i: number, of: number): Promise<void> {
	const spu = (await Spu.findOne({ 'particleLink.particleDeviceId': particleDeviceId }).select('_id udi').lean()) as any;
	await DeviceChunkJob.updateOne(
		{ particleDeviceId, kind, chunkId },
		{
			$setOnInsert: { _id: generateId(), status: 'receiving', received: [], spuId: spu?._id ?? null, spuUdi: spu?.udi ?? null },
			$set: { progress: { i, of, at: new Date() } }
		},
		{ upsert: true }
	);
}

/** Jobs with holes or still receiving — what the pages show as "waiting on the device". */
export async function openJobs(kind?: DeviceChunkKind, limit = 50) {
	const q: Record<string, unknown> = { status: { $ne: 'assembled' } };
	if (kind) q.kind = kind;
	const jobs = (await DeviceChunkJob.find(q).sort({ updatedAt: -1 }).limit(limit).lean()) as any[];
	return jobs.map((j) => {
		const received: number[] = j.received ?? [];
		const total: number = j.total ?? 0;
		const missing: number[] = [];
		for (let i = 0; i < total; i++) if (!received.includes(i)) missing.push(i);
		return {
			id: j._id as string,
			kind: j.kind as DeviceChunkKind,
			chunkId: j.chunkId as string,
			particleDeviceId: j.particleDeviceId as string,
			spuId: (j.spuId ?? null) as string | null,
			spuUdi: (j.spuUdi ?? null) as string | null,
			status: j.status as string,
			received: received.length,
			total,
			missing,
			progress: j.progress ?? null,
			lastError: (j.lastError ?? null) as string | null,
			firstChunkAt: j.firstChunkAt ? new Date(j.firstChunkAt).toISOString() : null,
			lastChunkAt: j.lastChunkAt ? new Date(j.lastChunkAt).toISOString() : null
		};
	});
}
