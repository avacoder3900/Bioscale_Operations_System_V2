/**
 * Phase 2 rename endpoint: rename CV R2 files from the long camera-capture
 * format to `{barcode}-{NNN}-{stage}.{ext}` inside the same project folder.
 *
 * Old: cv/wax-filling/plJMTw4b2IYZZgBqJsJ00_cartridge_capture_5af16c8c-7213-44cf-ad88-7e8e269e4ac3_001.jpg
 * New: cv/wax-filling/5af16c8c-7213-44cf-ad88-7e8e269e4ac3-001-wax.jpg
 *
 * Barcode    : text after "cartridge_capture_" in the original filename (regex-parsed).
 * Stage      : short alias from cartridgeTag.phase (STAGE_ALIASES below, or slugified).
 * Sequence   : 001, 002, 003... ordered by capturedAt ASC, grouped by (barcode, stage).
 *              Keep all — no 2-photo cap enforced retroactively.
 *
 * Photos with no cartridgeTag or no "cartridge_capture_" segment are SKIPPED.
 *
 * Same lifecycle as migrate-r2-names: preview → execute → cleanup (two-phase for safety).
 *
 * Auth: x-api-key = AGENT_API_KEY.
 * POST body: { mode: 'preview'|'execute'|'cleanup', project?, limit? }
 *
 * Delete this route after completion.
 */
import { json } from '@sveltejs/kit';
import mongoose from 'mongoose';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { env } from '$env/dynamic/private';
import { getR2Url, copyViaWorker, deleteViaWorker } from '$lib/server/services/r2';
import type { RequestHandler } from './$types';

export const config = {
	runtime: 'nodejs20.x',
	maxDuration: 300
};

const LOG_COLLECTION = 'r2_rename_log';

const STAGE_ALIASES: Record<string, string> = {
	wax_filling: 'wax',
	wax_filled: 'wax',
	wax_fill: 'wax',
	reagent_filling: 'reagent',
	reagent_filled: 'reagent',
	reagent_fill: 'reagent',
	sealed: 'seal',
	seal: 'seal',
	top_seal: 'seal',
	cured: 'cure',
	cure: 'cure',
	oven_cure: 'cure',
	backing: 'backing'
};

function shortStage(phase: string): string {
	const k = phase.toLowerCase().trim();
	if (STAGE_ALIASES[k]) return STAGE_ALIASES[k];
	return k.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'stage';
}

/**
 * Infer a stage from the project slug (the part after `cv/`) when the image
 * has no cartridgeTag.phase. Prefers the alias list; otherwise substring-matches
 * common stage keywords. Falls back to the slug itself.
 */
const SLUG_STAGE_HINTS: Array<[RegExp, string]> = [
	[/wax/, 'wax'],
	[/reagent/, 'reagent'],
	[/seal/, 'seal'],
	[/cure/, 'cure'],
	[/back/, 'backing']
];
function stageFromSlug(slug: string): string {
	for (const [re, stage] of SLUG_STAGE_HINTS) {
		if (re.test(slug)) return stage;
	}
	return slug;
}

/**
 * Parse a filename like
 *   "{nanoid}_cartridge_capture_{barcode}_{NNN}.jpg"
 * and extract the barcode and extension. The nanoid and capture sequence are dropped.
 */
const CAPTURE_RE = /cartridge_capture_([A-Za-z0-9-]+?)_\d+\.([A-Za-z0-9]+)$/;

function parseCapture(filename: string): { barcode: string; ext: string } | null {
	const m = filename.match(CAPTURE_RE);
	if (!m) return null;
	return { barcode: m[1], ext: m[2].toLowerCase() };
}

/**
 * Has this filePath already been renamed to the new pattern?
 * New pattern: ends with `{barcode}-{digits}-{stage}.{ext}`.
 */
const NEW_PATTERN_RE = /\/[A-Za-z0-9-]+-\d{3,}-[a-z0-9-]+\.[a-z]+$/;
function isAlreadyRenamed(key: string): boolean {
	return NEW_PATTERN_RE.test(key);
}

type Mode = 'preview' | 'execute' | 'cleanup';

interface LogEntry {
	_id: string;
	imageId: string;
	oldKey: string;
	newKey: string;
	oldThumb?: string;
	newThumb?: string;
	renamedAt: Date;
	oldKeyDeleted?: boolean;
	oldThumbDeleted?: boolean;
}

export const POST: RequestHandler = async ({ request }) => {
	const apiKey = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key');
	if (apiKey !== env.AGENT_API_KEY) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	let body: { mode?: Mode; project?: string; limit?: number } = {};
	try { body = await request.json(); } catch { /* empty ok */ }
	const mode: Mode = body.mode || 'preview';
	const projectFilter = body.project?.trim();
	const limit = Math.max(1, Math.min(body.limit ?? 500, 2000));

	await connectDB();

	if (mode === 'cleanup') return json(await runCleanup(limit));
	return json(await runRename(mode === 'execute', projectFilter, limit));
};

async function runRename(execute: boolean, projectFilter: string | undefined, limit: number) {
	const db = mongoose.connection.db!;

	const projQuery: any = {};
	if (projectFilter) projQuery.$or = [{ _id: projectFilter }, { name: projectFilter }];
	const projects = await CvProject.find(projQuery).select('_id name').lean();
	const projIds = projects.map(p => String(p._id));

	// Full rename: every image with a filePath. Sort by capturedAt for stable seq.
	const imgQuery: any = { filePath: { $exists: true, $ne: null } };
	if (projectFilter) imgQuery.projectId = { $in: projIds };

	const images = await CvImage.find(imgQuery)
		.select('_id projectId filePath thumbnailPath filename capturedAt createdAt cartridgeTag')
		.sort({ capturedAt: 1, createdAt: 1, _id: 1 })
		.lean();

	// Sequence counter keyed by `${barcode}::${stage}`.
	const seqCounter = new Map<string, number>();

	const samples: any[] = [];
	let scanned = 0;
	let processed = 0;
	let skippedAlreadyRenamed = 0;
	let skippedNoPath = 0;
	let failed = 0;
	const failures: { imageId: string; oldKey: string; error: string }[] = [];
	const stageHistogram: Record<string, number> = {};
	const barcodeSourceHistogram = { capture: 0, nanoid: 0 };
	const stageSourceHistogram = { phaseTag: 0, slugInference: 0 };

	for (const img of images) {
		scanned++;
		if (processed >= limit) continue;

		const oldKey = img.filePath as string;
		if (!oldKey) { skippedNoPath++; continue; }
		if (isAlreadyRenamed(oldKey)) { skippedAlreadyRenamed++; continue; }

		const tail = oldKey.slice(oldKey.lastIndexOf('/') + 1);
		const prefix = oldKey.slice(0, oldKey.lastIndexOf('/'));
		const projectSlug = prefix.replace(/^cv\//, '').split('/')[0];

		// Barcode: UUID from filename, or fall back to image _id.
		const parsed = parseCapture(tail);
		let barcode: string;
		let ext: string;
		if (parsed) {
			barcode = parsed.barcode;
			ext = parsed.ext;
			barcodeSourceHistogram.capture++;
		} else {
			barcode = String(img._id);
			const dot = tail.lastIndexOf('.');
			ext = (dot >= 0 ? tail.slice(dot + 1) : 'jpg').toLowerCase();
			barcodeSourceHistogram.nanoid++;
		}

		// Stage: cartridgeTag.phase alias, or infer from project slug.
		const tag: any = img.cartridgeTag;
		let stage: string;
		if (tag?.phase) {
			stage = shortStage(String(tag.phase));
			stageSourceHistogram.phaseTag++;
		} else {
			stage = stageFromSlug(projectSlug);
			stageSourceHistogram.slugInference++;
		}

		stageHistogram[stage] = (stageHistogram[stage] || 0) + 1;
		const groupKey = `${barcode}::${stage}`;
		const seq = (seqCounter.get(groupKey) || 0) + 1;
		seqCounter.set(groupKey, seq);
		const seqStr = String(seq).padStart(3, '0');

		const newKey = `${prefix}/${barcode}-${seqStr}-${stage}.${ext}`;

		// Thumbnail: old thumbs live at `{prefix}/thumbs/{nanoid}.jpg`. Give them the same new stem + .jpg.
		const oldThumb = img.thumbnailPath as string | undefined;
		let newThumb: string | undefined;
		if (oldThumb && oldThumb.includes('/thumbs/')) {
			const thumbDir = oldThumb.slice(0, oldThumb.lastIndexOf('/'));
			newThumb = `${thumbDir}/${barcode}-${seqStr}-${stage}.jpg`;
		}

		processed++;
		if (samples.length < 5) {
			samples.push({ phase: tag?.phase || null, stage, barcode, seq: seqStr, oldKey, newKey });
		}

		if (!execute) continue;

		try {
			await copyViaWorker(oldKey, newKey);
			if (oldThumb && newThumb) {
				try { await copyViaWorker(oldThumb, newThumb); }
				catch { newThumb = undefined; }
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
				renamedAt: new Date()
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
		skippedAlreadyRenamed,
		skippedNoPath,
		failed,
		complete: scanned <= processed + skippedAlreadyRenamed + skippedNoPath,
		stageHistogram,
		barcodeSourceHistogram,
		stageSourceHistogram,
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
			await deleteViaWorker(entry.oldKey);
			if (entry.oldThumb) {
				try { await deleteViaWorker(entry.oldThumb); } catch { /* best-effort */ }
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
