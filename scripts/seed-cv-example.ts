/**
 * Seed a self-contained CV demo into Mongo: N example cartridges whose
 * photos[] carry the full new-style QC truth, plus one demo CvProject ready
 * to train from the UI (/cv/projects).
 *
 *   npx tsx scripts/seed-cv-example.ts               # seed 10 cartridges
 *   npx tsx scripts/seed-cv-example.ts --count 25    # seed N
 *   npx tsx scripts/seed-cv-example.ts --cleanup     # remove everything it made
 *
 * Isolation guarantees:
 *   - Every cartridge _id starts with CVDEMO- (easy to find, easy to purge).
 *   - All demo photos use phase 'cvdemo' and the demo project's phases=['cvdemo'],
 *     so NO real capture ever routes inference through the demo model, and the
 *     demo photos never appear in real phase queries.
 *   - Photo URLs are sampled from REAL existing R2 photos (grouped by phase:
 *     approved-labeled demo photos come from one real phase, rejected from
 *     another) so embedding + training genuinely work AND the classifier has
 *     real visual signal to separate.
 *
 * Raw driver on purpose (no $lib alias resolution needed under tsx).
 */
import mongoose from 'mongoose';
import { customAlphabet } from 'nanoid';
import * as dotenv from 'dotenv';

dotenv.config();
dotenv.config({ path: '.env.local', override: false });

const URI = process.env.MONGODB_URI;
if (!URI) throw new Error('MONGODB_URI not set');

const nanoid = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 12);
const CLEANUP = process.argv.includes('--cleanup');
const countIdx = process.argv.indexOf('--count');
const COUNT = countIdx > -1 ? Math.max(3, parseInt(process.argv[countIdx + 1] ?? '10', 10)) : 10;

const DEMO_PHASE = 'cvdemo';
const DEMO_PROJECT_ID = 'CVDEMO-project';
const DEMO_LABELS = ['cvdemo-wax-overflow', 'cvdemo-misaligned-lid'];
const OPERATOR = { _id: 'CVDEMO-operator', username: 'cv-demo-seed' };

async function main() {
	await mongoose.connect(URI as string);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const projects = db.collection('cv_projects');
	const failureLabels = db.collection('failure_labels');
	const cvImages = db.collection('cv_images');
	const inspections = db.collection('cv_inspections');

	if (CLEANUP) {
		const demoCarts = await carts.find({ _id: /^CVDEMO-/ as any }).project({ photos: 1 }).toArray();
		const imageIds = demoCarts.flatMap((c: any) => (c.photos ?? []).map((p: any) => p.imageId));
		const r1 = await carts.deleteMany({ _id: /^CVDEMO-/ as any });
		const r2 = await projects.deleteMany({ _id: DEMO_PROJECT_ID as any });
		const r3 = await failureLabels.deleteMany({ text: { $in: DEMO_LABELS } });
		const r4 = imageIds.length ? await cvImages.deleteMany({ _id: { $in: imageIds } }) : { deletedCount: 0 };
		const r5 = await inspections.deleteMany({ projectId: DEMO_PROJECT_ID });
		console.log(`Cleanup: ${r1.deletedCount} cartridges, ${r2.deletedCount} project, ${r3.deletedCount} labels, ${r4.deletedCount} cv_images cache rows, ${r5.deletedCount} inspections.`);
		await mongoose.disconnect();
		return;
	}

	// ── Sample real photo URLs, grouped by real phase, so the demo classifier
	//    has genuine visual signal (photos of phase A look different from B).
	const byPhase = await carts.aggregate([
		{ $match: { _id: { $not: /^CVDEMO-/ } as any, 'photos.r2Url': { $exists: true } } },
		{ $unwind: '$photos' },
		{ $match: { 'photos.r2Url': { $type: 'string', $ne: '' } } },
		{ $group: { _id: '$photos.phase', urls: { $addToSet: '$photos.r2Url' } } },
		{ $project: { _id: 1, urls: { $slice: ['$urls', 200] }, n: { $size: '$urls' } } },
		{ $sort: { n: -1 } },
		{ $limit: 2 }
	]).toArray();

	if (byPhase.length < 2 || byPhase[1].urls.length < COUNT) {
		console.warn(`Only ${byPhase.length} phase group(s) with real photos — falling back to one pool (metrics will be near-random).`);
	}
	const poolApproved: string[] = byPhase[0]?.urls ?? [];
	const poolRejected: string[] = (byPhase[1]?.urls?.length ? byPhase[1].urls : poolApproved) as string[];
	if (!poolApproved.length) throw new Error('No real photos with r2Url found to sample — capture some photos first.');
	console.log(`Sampling approved-demo images from real phase "${byPhase[0]._id}" (${poolApproved.length} urls), rejected-demo from "${byPhase[1]?._id ?? byPhase[0]._id}" (${poolRejected.length} urls).`);

	// ── Demo failure-label vocabulary (select-only tags used on rejects).
	for (const text of DEMO_LABELS) {
		await failureLabels.updateOne(
			{ text },
			{ $setOnInsert: { _id: nanoid(), text, createdBy: OPERATOR, createdAt: new Date() } },
			{ upsert: true }
		);
	}

	// ── N demo cartridges, 2 photos each (~60% approved / 40% rejected).
	const now = Date.now();
	let photoCount = 0, approvedCount = 0, rejectedCount = 0;
	for (let i = 0; i < COUNT; i++) {
		const cartId = `CVDEMO-${String(i + 1).padStart(3, '0')}-${nanoid()}`;
		const photos = [];
		for (let j = 0; j < 2; j++) {
			const rejected = (i * 2 + j) % 5 >= 3; // deterministic ~40%
			const pool = rejected ? poolRejected : poolApproved;
			const url = pool[(i * 2 + j) % pool.length];
			const imageId = `CVDEMO-img-${nanoid()}`;
			const capturedAt = new Date(now - (COUNT - i) * 3600_000 - j * 60_000);
			const label = DEMO_LABELS[(i + j) % DEMO_LABELS.length];
			photos.push({
				imageId,
				phase: DEMO_PHASE,
				capturedAt,
				capturedBy: OPERATOR,
				r2Key: url.replace(/^https?:\/\/[^/]+\//, ''),
				r2Url: url,
				cartridgeImageNumber: `${cartId}_${String(j + 1).padStart(3, '0')}`,
				qcLabel: rejected ? 'rejected' : 'approved',
				qcLabeledBy: OPERATOR,
				qcLabeledAt: new Date(capturedAt.getTime() + 300_000),
				labels: rejected ? [label] : [],
				notes: rejected ? `Demo reject — ${label.replace('cvdemo-', '').replace('-', ' ')}` : '',
				annotations: rejected && j === 0
					? [{ x: 0.35, y: 0.4, w: 0.2, h: 0.15, tag: label, color: '#facc15', savedBy: OPERATOR, savedAt: capturedAt }]
					: []
			});
			photoCount++;
			rejected ? rejectedCount++ : approvedCount++;
		}
		await carts.updateOne(
			{ _id: cartId as any },
			{ $setOnInsert: {
				_id: cartId,
				status: 'stored',
				photos,
				photoSequence: photos.length,
				notes: [],
				corrections: [],
				createdAt: new Date(now - (COUNT - i) * 3600_000),
				updatedAt: new Date()
			}},
			{ upsert: true }
		);
	}

	// ── One demo project scoped to the demo phase, ready to train in the UI.
	await projects.updateOne(
		{ _id: DEMO_PROJECT_ID as any },
		{ $setOnInsert: {
			_id: DEMO_PROJECT_ID,
			name: 'CV Demo — Wax QC',
			description: `Seeded example (${COUNT} CVDEMO cartridges, ${photoCount} labeled photos). Train me from the Deployment tab.`,
			projectType: 'classification',
			phases: [DEMO_PHASE],
			modelStatus: 'untrained',
			trainedModels: [],
			activeModelVersion: null,
			shadowModelVersion: null,
			confidenceThreshold: 0.5,
			createdAt: new Date(),
			updatedAt: new Date()
		}},
		{ upsert: true }
	);

	console.log(`\nSeeded ${COUNT} CVDEMO cartridges / ${photoCount} photos (${approvedCount} approved, ${rejectedCount} rejected with tags+notes+annotations).`);
	console.log(`Project "${DEMO_PROJECT_ID}" (CV Demo — Wax QC) phases=[${DEMO_PHASE}] — untrained.`);
	console.log('\nNext: open /cv/projects → "CV Demo — Wax QC" → Train. Cleanup: --cleanup');
	await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
