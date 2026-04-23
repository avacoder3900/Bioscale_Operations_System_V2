/**
 * One-off admin endpoint to migrate CV image R2 keys from `cv/{projectId}/...`
 * to `cv/{projectNameSlug}/...` and backfill `r2Url` on cartridge photo refs.
 *
 * Auth: x-api-key header = AGENT_API_KEY.
 *
 * POST with JSON body:
 *   { mode: 'preview' }                         → dry-run, report only
 *   { mode: 'execute', project?, limit? }       → copy + update Mongo
 *   { mode: 'cleanup', limit? }                 → delete old R2 keys from log
 *
 * project : CvProject _id or name (exact match), optional filter
 * limit   : cap images processed this call (default 500). Run repeatedly until complete=true.
 *
 * Delete this route after migration is done.
 */
import { json } from '@sveltejs/kit';
import mongoose from 'mongoose';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { env } from '$env/dynamic/private';
import { slugifyProjectName, getR2Url, copyInR2, deleteFromR2 } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const config = {
	runtime: 'nodejs20.x',
	maxDuration: 300
};

const LOG_COLLECTION = 'r2_migration_log';

type Mode = 'preview' | 'execute' | 'cleanup';

interface LogEntry {
	_id: string;
	imageId: string;
	oldKey: string;
	newKey: string;
	oldThumb?: string;
	newThumb?: string;
	migratedAt: Date;
	oldKeyDeleted?: boolean;
	oldThumbDeleted?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
	const apiKey = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key');
	if (apiKey !== env.AGENT_API_KEY) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { mode?: Mode; project?: string; limit?: number } = {};
	try { body = await request.json(); } catch { /* empty body ok */ }
	const mode: Mode = body.mode || 'preview';
	const projectFilter = body.project?.trim();
	const limit = Math.max(1, Math.min(body.limit ?? 500, 2000));

	await connectDB();

	if (mode === 'cleanup') {
		return json(await runCleanup(limit));
	}
	return json(await runMigrate(mode === 'execute', projectFilter, limit));
};

async function runMigrate(execute: boolean, projectFilter: string | undefined, limit: number) {
	const db = mongoose.connection.db!;

	const projQuery: any = {};
	if (projectFilter) {
		projQuery.$or = [{ _id: projectFilter }, { name: projectFilter }];
	}
	const projects = await CvProject.find(projQuery).select('_id name').lean();
	const projById = new Map(projects.map(p => [String(p._id), p]));

	const imgQuery: any = {};
	if (projectFilter) imgQuery.projectId = { $in: projects.map(p => String(p._id)) };

	const cursor = CvImage.find(imgQuery).select('_id projectId filePath thumbnailPath').lean().cursor();

	const samples: any[] = [];
	let scanned = 0;
	let processed = 0;
	let skippedAlreadyMigrated = 0;
	let skippedNoProject = 0;
	let skippedNoPath = 0;
	let failed = 0;
	const failures: { imageId: string; oldKey: string; error: string }[] = [];

	for await (const img of cursor) {
		scanned++;
		if (processed >= limit) continue;

		const proj = projById.get(String(img.projectId));
		if (!proj) { skippedNoProject++; continue; }
		const oldKey = img.filePath as string | undefined;
		if (!oldKey) { skippedNoPath++; continue; }

		const slug = slugifyProjectName(proj.name);
		if (oldKey.startsWith(`cv/${slug}/`)) { skippedAlreadyMigrated++; continue; }

		const tail = oldKey.slice(oldKey.lastIndexOf('/') + 1);
		const newKey = `cv/${slug}/${tail}`;

		const oldThumb = img.thumbnailPath as string | undefined;
		let newThumb: string | undefined;
		if (oldThumb) {
			const tTail = oldThumb.slice(oldThumb.lastIndexOf('/') + 1);
			newThumb = `cv/${slug}/thumbs/${tTail}`;
		}

		processed++;
		if (samples.length < 5) {
			samples.push({ project: proj.name, oldKey, newKey, oldThumb, newThumb });
		}

		if (!execute) continue;

		try {
			await copyInR2(oldKey, newKey);
			if (oldThumb && newThumb) {
				try { await copyInR2(oldThumb, newThumb); }
				catch { newThumb = undefined; /* thumb copy is best-effort */ }
			}

			const newUrl = getR2Url(newKey);
			const setOp: any = { filePath: newKey, imageUrl: newUrl };
			if (newThumb) setOp.thumbnailPath = newThumb;
			await CvImage.updateOne({ _id: img._id }, { $set: setOp });

			await CartridgeRecord.updateMany(
				{ 'photos.imageId': img._id },
				{ $set: { 'photos.$[p].r2Key': newKey, 'photos.$[p].r2Url': newUrl } },
				{ arrayFilters: [{ 'p.imageId': img._id }] }
			);

			await db.collection(LOG_COLLECTION).insertOne({
				_id: String(img._id),
				imageId: String(img._id),
				oldKey,
				newKey,
				oldThumb,
				newThumb,
				migratedAt: new Date()
			} as LogEntry as any);
		} catch (err: any) {
			failed++;
			const cause = err.cause;
			const detail = cause
				? `${err.message} | cause: ${cause.code || cause.name || ''} ${cause.message || ''}`
				: err.message || String(err);
			failures.push({ imageId: String(img._id), oldKey, error: detail });
		}
	}

	return {
		mode: execute ? 'execute' : 'preview',
		projectsInScope: projects.length,
		scanned,
		processed,
		skippedAlreadyMigrated,
		skippedNoProject,
		skippedNoPath,
		failed,
		complete: scanned <= processed + skippedAlreadyMigrated + skippedNoProject + skippedNoPath,
		samples,
		failures: failures.slice(0, 10)
	};
}

async function runCleanup(limit: number) {
	const db = mongoose.connection.db!;
	const col = db.collection<LogEntry>(LOG_COLLECTION);
	const pending = await col.find({ oldKeyDeleted: { $ne: true } }).limit(limit).toArray();

	let deleted = 0;
	let failed = 0;
	const failures: { oldKey: string; error: string }[] = [];

	for (const entry of pending) {
		try {
			await deleteFromR2(entry.oldKey);
			if (entry.oldThumb) {
				try { await deleteFromR2(entry.oldThumb); } catch { /* ignore thumb delete errors */ }
			}
			await col.updateOne({ _id: entry._id }, { $set: { oldKeyDeleted: true, oldThumbDeleted: true } });
			deleted++;
		} catch (err: any) {
			failed++;
			failures.push({ oldKey: entry.oldKey, error: err.message || String(err) });
		}
	}

	const remaining = await col.countDocuments({ oldKeyDeleted: { $ne: true } });

	return {
		mode: 'cleanup',
		deleted,
		failed,
		remaining,
		complete: remaining === 0,
		failures: failures.slice(0, 10)
	};
}
