/**
 * One-time migration: clear the slate for the cartridge-first CV refactor.
 *
 * What it does (in order):
 *  1. Dumps a complete markdown ledger of every project and its images to
 *     docs/CV-PROJECT-LEDGER-<timestamp>.md — committed to the repo as a
 *     permanent backup. Reconstructible by hand if we ever regret the wipe.
 *  2. Sets cv_images.projectId = null on every image. Images survive, lose
 *     their project membership. Labels, cartridgeTag, R2 URLs all retained.
 *  3. Deletes every document in cv_projects. All 27 of them.
 *
 * Why this is safe:
 *  - cv_inspections has 0 documents — no orphaned references.
 *  - CartridgeRecord.photos[] references images by imageId + r2Key, not by
 *    project — no breakage on the cartridge side.
 *  - R2 storage is untouched. Photo URLs keep working.
 *  - The 100 labeled images keep their labels (label is a field on the image,
 *    not derived from project membership).
 *
 * Why this might still be a bad idea:
 *  - The Python camera_capture.py scripts use CV_DEFAULT_PROJECT_ID env var
 *    pointing at a project that won't exist anymore. They'll 404 on
 *    /api/cv/capture-ingest until either the env is changed or the new
 *    cartridge-first capture endpoint is wired up.
 *
 * Run with: npx tsx scripts/wipe-cv-projects-cartridge-first.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI env var not set');
	process.exit(1);
}

function tsForFilename(): string {
	return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function main() {
	await mongoose.connect(MONGODB_URI as string);
	const db = mongoose.connection.db!;

	const cvProj = db.collection('cv_projects');
	const cvImg = db.collection('cv_images');

	const [projectCount, imageCount] = await Promise.all([
		cvProj.countDocuments(),
		cvImg.countDocuments()
	]);

	console.log(`Found ${projectCount} cv_projects, ${imageCount} cv_images.`);
	console.log();

	if (projectCount === 0 && imageCount === 0) {
		console.log('Nothing to do. Exiting.');
		await mongoose.disconnect();
		return;
	}

	// ---- STEP 1: Build the markdown ledger ----
	const projects = await cvProj.find({}).toArray();
	const imagesByProject = new Map<string | null, any[]>();
	const allImages = await cvImg.find({}, {
		projection: {
			_id: 1, projectId: 1, filename: 1, label: 1, capturedAt: 1,
			imageUrl: 1, filePath: 1, cartridgeTag: 1, createdAt: 1
		}
	}).toArray();
	for (const img of allImages) {
		const key = img.projectId ?? null;
		const bucket = imagesByProject.get(key) ?? [];
		bucket.push(img);
		imagesByProject.set(key, bucket);
	}

	const lines: string[] = [];
	lines.push('# CV Project Ledger — pre-wipe backup');
	lines.push('');
	lines.push(`**Generated:** ${new Date().toISOString()}`);
	lines.push(`**Reason:** Cartridge-first CV refactor. Wiping cv_projects, nulling cv_images.projectId.`);
	lines.push(`**Counts:** ${projectCount} projects, ${imageCount} images.`);
	lines.push('');
	lines.push('This file is the permanent record of project→image membership at the moment of');
	lines.push('the wipe. If we need to reconstruct curated training sets later, they can be');
	lines.push('rebuilt by hand from this ledger.');
	lines.push('');
	lines.push('---');
	lines.push('');

	for (const p of projects) {
		const imgs = imagesByProject.get(p._id) ?? [];
		lines.push(`## ${p.name ?? '(no name)'} — \`${p._id}\``);
		lines.push('');
		const meta: string[] = [];
		if (p.description) meta.push(`**Description:** ${p.description}`);
		if (p.purpose) meta.push(`**Purpose:** ${p.purpose}`);
		if (p.projectType) meta.push(`**Type:** ${p.projectType}`);
		if (p.modelStatus) meta.push(`**Model status:** ${p.modelStatus}`);
		if (p.modelVersion) meta.push(`**Model version:** ${p.modelVersion}`);
		if (p.confidenceThreshold != null) meta.push(`**Confidence threshold:** ${p.confidenceThreshold}`);
		if (p.isMasterModel) meta.push(`**isMasterModel:** true`);
		if (p.tags?.length) meta.push(`**Tags:** ${p.tags.join(', ')}`);
		if (p.phases?.length) meta.push(`**Phases:** ${p.phases.join(', ')}`);
		if (p.createdAt) meta.push(`**Created:** ${new Date(p.createdAt).toISOString()}`);
		for (const m of meta) lines.push(`- ${m}`);
		lines.push('');
		lines.push(`**Image count:** ${imgs.length}`);
		lines.push('');
		if (imgs.length > 0) {
			lines.push('| Image ID | Filename | Label | Cartridge | Phase | Captured |');
			lines.push('|---|---|---|---|---|---|');
			for (const img of imgs) {
				const cartId = img.cartridgeTag?.cartridgeRecordId ?? '—';
				const phase = img.cartridgeTag?.phase ?? '—';
				const captured = img.capturedAt
					? new Date(img.capturedAt).toISOString()
					: (img.createdAt ? new Date(img.createdAt).toISOString() : '—');
				const fname = (img.filename ?? '').replace(/\|/g, '\\|');
				const lbl = img.label ?? '—';
				lines.push(`| \`${img._id}\` | ${fname} | ${lbl} | ${cartId} | ${phase} | ${captured} |`);
			}
		} else {
			lines.push('_(no images in this project)_');
		}
		lines.push('');
	}

	// Orphan images (no projectId — shouldn't exist today but be defensive)
	const orphans = imagesByProject.get(null) ?? [];
	if (orphans.length > 0) {
		lines.push('## ORPHANS — images with no projectId at wipe time');
		lines.push('');
		lines.push(`**Image count:** ${orphans.length}`);
		lines.push('');
		lines.push('| Image ID | Filename | Label | Cartridge | Phase | Captured |');
		lines.push('|---|---|---|---|---|---|');
		for (const img of orphans) {
			const cartId = img.cartridgeTag?.cartridgeRecordId ?? '—';
			const phase = img.cartridgeTag?.phase ?? '—';
			const captured = img.capturedAt
				? new Date(img.capturedAt).toISOString()
				: (img.createdAt ? new Date(img.createdAt).toISOString() : '—');
			const fname = (img.filename ?? '').replace(/\|/g, '\\|');
			const lbl = img.label ?? '—';
			lines.push(`| \`${img._id}\` | ${fname} | ${lbl} | ${cartId} | ${phase} | ${captured} |`);
		}
		lines.push('');
	}

	const ledgerPath = path.join(
		path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
		'..',
		'docs',
		`CV-PROJECT-LEDGER-${tsForFilename()}.md`
	);
	// Path normalization — works on Windows where import.meta.url is file:///C:/...
	const normalizedPath = path.normalize(ledgerPath);
	fs.writeFileSync(normalizedPath, lines.join('\n'), 'utf-8');
	console.log(`✓ Ledger written to: ${normalizedPath}`);
	console.log(`  ${lines.length} lines, ${projectCount} projects, ${imageCount} images recorded.`);
	console.log();

	// ---- STEP 2: Null out projectId on every image ----
	console.log('Step 2: Unassigning projectId from all images...');
	const unsetResult = await cvImg.updateMany(
		{},
		{ $set: { projectId: null } }
	);
	console.log(`✓ Updated ${unsetResult.modifiedCount} images (projectId → null).`);
	console.log();

	// ---- STEP 3: Delete all cv_projects ----
	console.log('Step 3: Deleting all cv_projects...');
	const delResult = await cvProj.deleteMany({});
	console.log(`✓ Deleted ${delResult.deletedCount} projects.`);
	console.log();

	// ---- Post-state verification ----
	const [postProjCount, postImgCount, postImgWithProj] = await Promise.all([
		cvProj.countDocuments(),
		cvImg.countDocuments(),
		cvImg.countDocuments({ projectId: { $ne: null } })
	]);
	console.log('=== POST-WIPE STATE ===');
	console.log(`cv_projects:                        ${postProjCount} (was ${projectCount})`);
	console.log(`cv_images total:                    ${postImgCount} (was ${imageCount})`);
	console.log(`cv_images with non-null projectId:  ${postImgWithProj} (should be 0)`);
	console.log();

	if (postProjCount === 0 && postImgWithProj === 0 && postImgCount === imageCount) {
		console.log('✓ Wipe complete. All images preserved, no project membership.');
	} else {
		console.log('⚠ Post-wipe state looks unexpected. Verify before proceeding.');
	}

	await mongoose.disconnect();
}

main().catch(err => {
	console.error(err);
	process.exit(1);
});
