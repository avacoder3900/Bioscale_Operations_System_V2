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
const NEW_PATTERN_RE = /\/[A-Za-z0-9_-]+-\d{3,}-[a-z0-9-]+\.[a-z]+$/;
function isAlreadyRenamed(key: string): boolean {
	return NEW_PATTERN_RE.test(key);
}

type Mode = 'preview' | 'execute' | 'cleanup' | 'discover-cartridges' | 'backfill-cartridges' | 'reconcile-mongo-to-r2';

/**
 * Project-slug → CartridgeRecord.status enum value for cartridgeTag.phase.
 * Used to infer phase when backfilling. Projects that don't map to a specific
 * stage (experiments, unlabelled) get null → skipped.
 */
const SLUG_TO_PHASE: Record<string, string | null> = {
	'wax-filling': 'wax_filling',
	'wax-filling-real': 'wax_filling',
	'reagent-filling': 'reagent_filled',
	'reagent-fill-4-7-1': 'reagent_filled',
	'fill-1': 'reagent_filled',
	'fill-2': 'reagent_filled',
	'fill-3': 'reagent_filled',
	'fill-4': 'reagent_filled',
	'exp-270': null,
	'exp-271': null
};

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
	if (mode === 'discover-cartridges') return json(await runDiscover(limit));
	if (mode === 'backfill-cartridges') return json(await runBackfill(body.mode === 'backfill-cartridges' ? false : true, limit));
	if (mode === 'reconcile-mongo-to-r2') return json(await runReconcile(Boolean((body as any).execute), limit));
	return json(await runRename(mode === 'execute', projectFilter, limit));
};

/**
 * Reconcile CvImage ↔ R2: delete CvImage documents whose filePath no longer
 * corresponds to an object in R2. Checks existence via a HEAD to the Worker's
 * /file/ endpoint (public GET). Also strips orphaned entries from
 * CartridgeRecord.photos[].
 *
 * Body: { mode: 'reconcile-mongo-to-r2', execute?: boolean, limit? }
 *   - execute=false (default) → scan only, report what would be deleted.
 *   - execute=true → actually delete orphan CvImages + strip cartridge refs.
 */
async function runReconcile(execute: boolean, limit: number) {
	const workerUrl = env.R2_WORKER_URL;
	if (!workerUrl) {
		return { error: 'R2_WORKER_URL not configured' };
	}

	const images = await CvImage.find({ filePath: { $exists: true, $ne: null } })
		.select('_id filePath')
		.limit(limit)
		.lean();

	let scanned = 0;
	let present = 0;
	let orphaned = 0;
	let deletedImages = 0;
	let strippedCartridgeRefs = 0;
	let failed = 0;
	const orphanSamples: { imageId: string; filePath: string }[] = [];
	const failures: { imageId: string; error: string }[] = [];

	for (const img of images) {
		scanned++;
		const key = img.filePath as string;
		const checkUrl = `${workerUrl}/file/${encodeURIComponent(key)}`;

		let exists = false;
		try {
			const res = await fetch(checkUrl, { method: 'HEAD' });
			exists = res.ok;
		} catch (err: any) {
			failed++;
			failures.push({ imageId: String(img._id), error: `HEAD failed: ${err.message || err}` });
			continue;
		}

		if (exists) { present++; continue; }

		orphaned++;
		if (orphanSamples.length < 10) {
			orphanSamples.push({ imageId: String(img._id), filePath: key });
		}

		if (!execute) continue;

		try {
			await CvImage.deleteOne({ _id: img._id });
			deletedImages++;

			// Strip orphan photo refs from any cartridge that had this image.
			const res = await CartridgeRecord.updateMany(
				{ 'photos.imageId': img._id },
				{ $pull: { photos: { imageId: img._id } } }
			);
			strippedCartridgeRefs += res.modifiedCount || 0;
		} catch (err: any) {
			failed++;
			failures.push({ imageId: String(img._id), error: err.message || String(err) });
		}
	}

	return {
		mode: 'reconcile-mongo-to-r2',
		execute,
		scanned,
		present,
		orphaned,
		deletedImages,
		strippedCartridgeRefs,
		failed,
		complete: scanned < limit,
		orphanSamples,
		failures: failures.slice(0, 10)
	};
}

/**
 * Backfill CvImage.cartridgeTag for images that were captured with a UUID in
 * their old filename matching a CartridgeRecord._id. Uses the rename log to
 * recover the original UUID (current filePath is the renamed key).
 *
 * For each matched image:
 *   - Sets cartridgeTag.cartridgeRecordId = UUID
 *   - Sets cartridgeTag.phase from the project-slug map (if not already set)
 *   - Ensures a corresponding entry in CartridgeRecord.photos[] (dedup by imageId)
 *
 * Projects without a reliable phase mapping (e.g. experiments) → skipped.
 *
 * Pass dryRun=true via { mode: 'backfill-cartridges', dryRun: true } ... actually
 * for simplicity this is always write-mode; call with { limit: 5 } first as a spot-check.
 */
async function runBackfill(_writeMode: boolean, limit: number) {
	const db = mongoose.connection.db!;
	const cartridges = db.collection('cartridge_records');
	const log = db.collection(LOG_COLLECTION);

	// For each renamed image, pull its oldKey UUID + cartridgeRecordId candidate.
	const entries = await log.find({}).limit(limit).toArray();

	const samples: any[] = [];
	let scanned = 0;
	let updatedImages = 0;
	let pushedPhotoRefs = 0;
	let skippedNoUuid = 0;
	let skippedNoCartridge = 0;
	let skippedNoPhaseMap = 0;
	let skippedAlreadyTagged = 0;
	let failed = 0;
	const failures: { imageId: string; error: string }[] = [];

	for (const entry of entries) {
		scanned++;
		const oldKey = entry.oldKey as string;
		const newKey = entry.newKey as string;
		const imageId = String(entry.imageId);

		const tail = oldKey.slice(oldKey.lastIndexOf('/') + 1);
		const m = tail.match(/cartridge_capture_([A-Za-z0-9-]+?)_\d+\./);
		if (!m) { skippedNoUuid++; continue; }
		const uuid = m[1];

		// Does a cartridge with this _id exist?
		const cartridge = await cartridges.findOne({ _id: uuid as any }, { projection: { _id: 1 } });
		if (!cartridge) { skippedNoCartridge++; continue; }

		// Derive phase from the project slug in newKey/oldKey.
		const projectSlug = newKey.replace(/^cv\//, '').split('/')[0];
		const phase = SLUG_TO_PHASE[projectSlug];
		if (phase === null || phase === undefined) { skippedNoPhaseMap++; continue; }

		// Read current CvImage cartridgeTag.
		const img = await CvImage.findById(imageId).select('cartridgeTag capturedAt filePath imageUrl').lean();
		if (!img) { failed++; failures.push({ imageId, error: 'CvImage not found' }); continue; }

		const currentTag: any = img.cartridgeTag || {};
		const alreadyFullyTagged = currentTag.cartridgeRecordId === uuid && currentTag.phase;
		if (alreadyFullyTagged) { skippedAlreadyTagged++; continue; }

		try {
			const newTag: any = {
				cartridgeRecordId: uuid,
				phase: currentTag.phase || phase,
				labels: currentTag.labels || [],
				notes: currentTag.notes || ''
			};
			await CvImage.updateOne({ _id: imageId }, { $set: { cartridgeTag: newTag } });
			updatedImages++;

			// Push into cartridge.photos[] if not already there. Some legacy cartridge
			// docs have photos stored as a non-array object; fetch-and-set handles both.
			const photoEntry = {
				imageId,
				phase: newTag.phase,
				capturedAt: img.capturedAt || null,
				r2Key: newKey,
				r2Url: img.imageUrl || null
			};
			const cartridgeDoc = await cartridges.findOne(
				{ _id: uuid as any },
				{ projection: { photos: 1 } }
			);
			const existingPhotos = Array.isArray(cartridgeDoc?.photos) ? cartridgeDoc!.photos : [];
			const alreadyIn = existingPhotos.some((p: any) => p?.imageId === imageId);
			if (!alreadyIn) {
				existingPhotos.push(photoEntry);
				await cartridges.updateOne(
					{ _id: uuid as any },
					{ $set: { photos: existingPhotos } }
				);
				pushedPhotoRefs++;
			}

			if (samples.length < 5) {
				samples.push({ imageId, uuid, projectSlug, phase: newTag.phase, newKey });
			}
		} catch (err: any) {
			failed++;
			failures.push({ imageId, error: err.message || String(err) });
		}
	}

	return {
		mode: 'backfill-cartridges',
		scanned,
		updatedImages,
		pushedPhotoRefs,
		skippedNoUuid,
		skippedNoCartridge,
		skippedNoPhaseMap,
		skippedAlreadyTagged,
		failed,
		complete: scanned < limit,
		samples,
		failures: failures.slice(0, 10)
	};
}

/**
 * For every CvImage whose filename contains a capture UUID, try to find any
 * CartridgeRecord field that equals that UUID. Report the distinct fields
 * that match so we can decide whether a safe automated backfill is possible.
 */
async function runDiscover(limit: number) {
	const db = mongoose.connection.db!;
	const cartridges = db.collection('cartridge_records');

	// Photos are already renamed; read UUIDs from the rename log's oldKey field.
	const logEntries = await db.collection(LOG_COLLECTION).find({}).limit(limit).toArray();

	const uuids = new Set<string>();
	const uuidToImageId: Record<string, string[]> = {};
	for (const entry of logEntries) {
		const oldKey = entry.oldKey as string;
		const tail = oldKey.slice(oldKey.lastIndexOf('/') + 1);
		const m = tail.match(/cartridge_capture_([A-Za-z0-9-]+?)_\d+\./);
		if (m) {
			const uuid = m[1];
			uuids.add(uuid);
			(uuidToImageId[uuid] ||= []).push(String(entry.imageId));
		}
	}

	// For each UUID, look it up across the entire cartridge_records collection
	// using a full-document $expr regex — slow but thorough. Limit distinct UUIDs
	// to avoid blowing past the function timeout.
	const sample = [...uuids].slice(0, 20);
	const results: { uuid: string; matches: { _id: string; fieldPath: string }[] }[] = [];

	for (const uuid of sample) {
		// $where is expensive; use a $or on likely text fields instead.
		// Candidate fields where a cartridge-level barcode could live.
		const q: any = { $or: [
			{ _id: uuid },
			{ 'backing.lotQrCode': uuid },
			{ 'backing.lotId': uuid },
			{ 'waxFilling.runId': uuid },
			{ 'reagentFilling.runId': uuid },
			{ 'storage.containerBarcode': uuid },
			{ 'shipping.packageBarcode': uuid },
			{ 'testExecution.spu.udi': uuid },
			{ 'testExecution.spu._id': uuid }
		]};
		const matches = await cartridges.find(q).limit(5).project({ _id: 1 }).toArray();
		if (matches.length) {
			// Find which field matched by re-querying one-by-one (just for the report).
			for (const m of matches) {
				const doc = await cartridges.findOne({ _id: m._id as any });
				if (!doc) continue;
				const fieldPath = findFieldByValue(doc, uuid);
				results.push({ uuid, matches: [{ _id: String(m._id), fieldPath: fieldPath || '(unknown)' }] });
			}
		}
	}

	return {
		mode: 'discover-cartridges',
		uuidsSampled: sample.length,
		totalCapturedUuids: uuids.size,
		matchesFound: results.length,
		results
	};
}

function findFieldByValue(obj: any, target: string, prefix = ''): string | null {
	if (obj === null || obj === undefined) return null;
	if (typeof obj === 'string') return obj === target ? prefix : null;
	if (Array.isArray(obj)) {
		for (let i = 0; i < obj.length; i++) {
			const r = findFieldByValue(obj[i], target, `${prefix}[${i}]`);
			if (r) return r;
		}
		return null;
	}
	if (typeof obj === 'object') {
		for (const [k, v] of Object.entries(obj)) {
			const r = findFieldByValue(v, target, prefix ? `${prefix}.${k}` : k);
			if (r) return r;
		}
	}
	return null;
}

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
