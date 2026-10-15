/**
 * MongoDB copy of every sonic recording (GridFS bucket `sonic_recordings`).
 *
 * R2 holds the original; this is the second, independent copy the team can fall
 * back to if anything goes wrong in R2 (2026-10-05 decision). GridFS stores the
 * file in 255 KB chunks, so recordings are not limited by Mongo's 16 MB document
 * cap. Each copy carries the SHA-256 of its bytes, recorded on the session as
 * results[0].rawData.mongoCopy, so the two copies can always be checked against
 * each other. Copies are never modified or deleted by BIMS.
 */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mongoose, ValidationSession, AuditLog, generateId } from '$lib/server/db';
import { fetchRecording } from './fetch';

export const RECORDING_BUCKET = 'sonic_recordings';

export interface MongoCopy {
	fileId: string;
	sha256: string;
	size: number;
	at: Date;
	by: string;
}

type Who = { _id: string; username: string };

function bucket(name = RECORDING_BUCKET) {
	const db = mongoose.connection.db;
	if (!db) throw new Error('database not connected');
	return new mongoose.mongo.GridFSBucket(db, { bucketName: name });
}

export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/** Write bytes into a GridFS bucket and return the new file's id. */
export async function putGridFile(
	bucketName: string,
	fileName: string,
	bytes: Uint8Array,
	metadata: Record<string, unknown>,
	contentType?: string
): Promise<string> {
	const b = bucket(bucketName);
	const upload = b.openUploadStream(fileName, { metadata: { ...metadata, ...(contentType ? { contentType } : {}) } });
	await new Promise<void>((resolve, reject) => {
		Readable.from([Buffer.from(bytes)])
			.pipe(upload)
			.on('finish', () => resolve())
			.on('error', reject);
	});
	return String(upload.id);
}

/** Read a whole GridFS file into memory (recordings are a few MB; spectrograms well under that). */
export async function readGridFile(bucketName: string, fileId: string): Promise<Uint8Array> {
	const b = bucket(bucketName);
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		b.openDownloadStream(new mongoose.Types.ObjectId(fileId))
			.on('data', (c: Buffer) => chunks.push(c))
			.on('end', () => resolve())
			.on('error', reject);
	});
	return new Uint8Array(Buffer.concat(chunks));
}

/** Size + stored metadata of a GridFS file, or null when it is gone. */
export async function statGridFile(bucketName: string, fileId: string): Promise<{ length: number; metadata: Record<string, any> } | null> {
	const files = await bucket(bucketName).find({ _id: new mongoose.Types.ObjectId(fileId) }).limit(1).toArray();
	const f = files[0];
	return f ? { length: f.length, metadata: (f.metadata ?? {}) as Record<string, any> } : null;
}

/** A byte range [start, endInclusive] of a GridFS file as a Node stream (for HTTP Range / audio seeking). */
export function streamGridFile(bucketName: string, fileId: string, start?: number, endInclusive?: number) {
	const opts = start != null && endInclusive != null ? { start, end: endInclusive + 1 } : undefined;
	return bucket(bucketName).openDownloadStream(new mongoose.Types.ObjectId(fileId), opts);
}

async function audit(action: string, sessionId: string, who: Who, newData: Record<string, unknown>) {
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action,
		newData,
		changedBy: who.username,
		changedAt: new Date()
	});
}

/**
 * Make sure this recording has a MongoDB copy. Uses `bytes` when the caller already
 * has them (the proxied upload), otherwise fetches the original back from R2.
 * Idempotent: a session whose copy already exists with the same checksum is left
 * alone. Never throws — a failed copy is recorded on the session
 * (rawData.mongoCopyError) and audited, and the recording stays valid (R2 has it).
 */
export async function ensureMongoCopy(
	sessionId: string,
	who: Who,
	bytes?: Uint8Array
): Promise<{ ok: true; copy: MongoCopy; created: boolean } | { ok: false; error: string }> {
	try {
		const s = (await ValidationSession.findById(sessionId).lean()) as any;
		if (!s || s.type !== 'sonic') throw new Error('Sonic recording not found');
		const res = s.results?.[0];
		const raw = res?.rawData ?? {};
		if (!res?._id || !raw.r2Key) throw new Error('This session has no stored recording');

		const existing = raw.mongoCopy as MongoCopy | undefined;
		if (existing?.fileId && (await statGridFile(RECORDING_BUCKET, existing.fileId))) {
			return { ok: true, copy: existing, created: false };
		}

		const data = bytes ?? (await fetchRecording(raw.r2Key));
		if (!data.byteLength) throw new Error('the recording is empty (0 bytes)');
		const hash = sha256(data);
		if (raw.size && data.byteLength !== raw.size) {
			throw new Error(`size mismatch: R2 has ${data.byteLength} bytes, the session recorded ${raw.size}`);
		}
		const fileId = await putGridFile(
			RECORDING_BUCKET,
			raw.fileName ?? 'recording',
			data,
			{ sessionId, spuId: s.spuId ?? null, spuUdi: s.spuUdi ?? null, r2Key: raw.r2Key, sha256: hash },
			raw.mimeType ?? undefined
		);
		const copy: MongoCopy = { fileId, sha256: hash, size: data.byteLength, at: new Date(), by: who.username };
		await ValidationSession.updateOne(
			{ _id: sessionId, 'results._id': res._id },
			{ $set: { 'results.$.rawData.mongoCopy': copy }, $unset: { 'results.$.rawData.mongoCopyError': '' } }
		);
		await audit('sonic_mongo_copy', sessionId, who, { spuUdi: s.spuUdi, r2Key: raw.r2Key, fileId, sha256: hash, size: data.byteLength });
		return { ok: true, copy, created: true };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		try {
			await ValidationSession.updateOne(
				{ _id: sessionId, 'results.0': { $exists: true } },
				{ $set: { 'results.0.rawData.mongoCopyError': { at: new Date(), by: who.username, error } } }
			);
			await audit('sonic_mongo_copy_failed', sessionId, who, { error });
		} catch (logErr) {
			console.warn(`[sonic] could not record the failed Mongo copy: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
		}
		return { ok: false, error };
	}
}
