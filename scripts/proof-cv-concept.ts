/**
 * Proof-of-concept: prove the repaired in-process CV pipeline trains a model,
 * PERSISTS it (the Mongoose strict-mode fix), and produces verdicts.
 * Uses the REAL cv-classifier functions + REAL Mongoose models (so strict mode
 * is exercised). Replicates the now-fixed triggerTraining/runInference logic.
 * Creates a throwaway master test project; cleans it up at the end.
 * Run: npx tsx scripts/proof-cv-concept.ts
 */
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' }); dotenv.config();
import mongoose from 'mongoose';
import { CvProject } from '../src/lib/server/db/models/cv-project.ts';
import { CvImage } from '../src/lib/server/db/models/cv-image.ts';
import { CvInspection } from '../src/lib/server/db/models/cv-inspection.ts';
import { embedImage, fitClassifier, predict, fetchImageBytes, EMBEDDING_VERSION } from '../src/lib/server/services/cv-classifier.ts';

const TEST_PHASE = '__concept_test__';
const ok = (b: boolean) => (b ? 'PASS ✓' : 'FAIL ✗');

await mongoose.connect(process.env.MONGODB_URI!);
let testId = '';
try {
  // --- gather labeled images (master = all labeled, both classes) ---
  const labelExpr = { $in: ['approved', 'rejected'] };
  const images = await CvImage.find({ $or: [{ qcLabel: labelExpr }, { label: labelExpr }] })
    .select('_id imageUrl filePath qcLabel label embedding embeddingVersion').lean() as any[];
  const labelOf = (i: any) => i.qcLabel ?? i.label ?? null;
  const approved = images.filter(i => labelOf(i) === 'approved').length;
  const rejected = images.filter(i => labelOf(i) === 'rejected').length;
  console.log(`Labeled images: ${images.length} (${approved} approved, ${rejected} rejected)`);
  if (images.length < 5 || approved === 0 || rejected === 0) throw new Error('insufficient labeled data');

  // --- create throwaway master test project ---
  const proj = await CvProject.create({
    name: `ZZ-CONCEPT-TEST ${new Date().toISOString()}`,
    projectType: 'classification', isMasterModel: true, deployAtPhases: [TEST_PHASE]
  });
  testId = proj._id;
  console.log(`Created test project ${testId}`);

  // --- TRAIN: embed (real sharp) + fit (real logistic regression) ---
  const X: number[][] = [], y: number[] = []; let embedded = 0;
  const t0 = Date.now();
  for (const img of images) {
    let emb = (img.embeddingVersion === EMBEDDING_VERSION && Array.isArray(img.embedding)) ? img.embedding : undefined;
    if (!emb) {
      const bytes = await fetchImageBytes(img.imageUrl);
      emb = await embedImage(bytes);
      await CvImage.updateOne({ _id: img._id }, { $set: { embedding: emb, embeddingVersion: EMBEDDING_VERSION } });
      embedded++;
      if (embedded % 20 === 0) console.log(`  embedded ${embedded}...`);
    }
    X.push(emb); y.push(labelOf(img) === 'approved' ? 1 : 0);
  }
  const classifier = fitClassifier(X, y);
  const modelVersion = `lr-${EMBEDDING_VERSION}-${Date.now()}`;
  console.log(`Trained in ${((Date.now()-t0)/1000).toFixed(1)}s (embedded ${embedded} new). acc=${(classifier.trainingAccuracy*100).toFixed(1)}% logloss=${classifier.trainingLogLoss.toFixed(4)} weights=${classifier.weights.length}`);

  // --- PERSIST THROUGH THE MODEL (the strict-mode fix under test) ---
  await CvProject.updateOne({ _id: testId }, { $set: { classifier, modelStatus: 'trained', modelVersion, trainingError: null } });
  const back = await CvProject.findById(testId).lean() as any;
  const persisted = !!back.classifier?.weights?.length;
  console.log(`\n[1] classifier persists through schema (strict-mode fix): ${ok(persisted)}  (weights read back = ${back.classifier?.weights?.length ?? 0})`);
  console.log(`[2] deployAtPhases persists: ${ok(JSON.stringify(back.deployAtPhases) === JSON.stringify([TEST_PHASE]))}  (${JSON.stringify(back.deployAtPhases)})`);

  // --- INFER on a few real images (real predict) ---
  const threshold = back.confidenceThreshold ?? 0.5;
  console.log(`\nSample verdicts (threshold ${threshold}):`);
  let correct = 0, n = 0;
  for (const img of images.slice(0, 8)) {
    const emb = (img.embeddingVersion === EMBEDDING_VERSION && Array.isArray(img.embedding)) ? img.embedding : await embedImage(await fetchImageBytes(img.imageUrl));
    const out = predict(emb, back.classifier, threshold);
    const truth = labelOf(img) === 'approved' ? 'pass' : 'fail';
    if (out.verdict === truth) correct++; n++;
    console.log(`  ${img._id.slice(0,8)}  truth=${truth.padEnd(4)} -> verdict=${out.verdict.padEnd(4)} p(pass)=${out.passProbability.toFixed(3)} ${out.verdict===truth?'✓':'✗'}`);
  }
  console.log(`[3] inference produces verdicts: ${ok(n>0)}  (${correct}/${n} match label on sampled set)`);

  // --- CAPTURE PATH: write a CvInspection verdict (what wax-inspect polls for) ---
  const sample = images[0];
  const emb0 = sample.embedding ?? await embedImage(await fetchImageBytes(sample.imageUrl));
  const out0 = predict(emb0, back.classifier, threshold);
  const inspId = 'concept-test-insp';
  await CvInspection.deleteOne({ _id: inspId });
  await CvInspection.create({ _id: inspId, imageId: sample._id, cartridgeRecordId: TEST_PHASE, phase: TEST_PHASE, projectId: testId, inspectionType: 'classification', modelVersion, status: 'processing' });
  await CvInspection.updateOne({ _id: inspId }, { $set: { status: 'complete', result: out0.verdict, confidenceScore: out0.percentConfidence/100, defects: out0.verdict==='fail'?[{type:'classifier_low_confidence',location:'global',severity:'high'}]:[], processingTimeMs: 1, completedAt: new Date() } });
  const insp = await CvInspection.findById(inspId).lean() as any;
  console.log(`\n[4] CvInspection verdict persists (wax-inspect poll target): ${ok(insp?.result === out0.verdict && insp?.status==='complete')}  (result=${insp?.result}, status=${insp?.status})`);

  console.log(`\nALL CORE ASSERTIONS: ${ok(persisted && n>0 && insp?.result===out0.verdict)}`);

  // --- CLEANUP (keep the real embeddings; drop only the test project + inspection) ---
  await CvInspection.deleteOne({ _id: inspId });
  await CvProject.deleteOne({ _id: testId });
  console.log(`\nCleaned up test project + inspection. (Real image embeddings kept — they're valid.)`);
} catch (e: any) {
  console.error('PROOF FAILED:', e?.message ?? e);
  if (testId) { await CvInspection.deleteOne({ _id: 'concept-test-insp' }); await CvProject.deleteOne({ _id: testId }); }
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
