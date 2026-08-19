import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const runs = db.collection('reagent_batch_records');
  const carts = db.collection('cartridge_records');
  const stuck = await runs.find({ status: { $in: ['Inspection','Top Sealing','Storage','inspection','top_sealing','storage'] } })
    .project({ _id:1,status:1,createdAt:1,robotReleasedAt:1,cartridgesFilled:1,'robot.name':1,sealBatches:1 }).sort({createdAt:1}).toArray() as any[];
  console.log('STUCK RUNS:', stuck.length);
  for (const r of stuck) {
    const ids = (r.cartridgesFilled??[]).map((c:any)=>c.cartridgeId);
    const sts = await carts.aggregate([{ $match: { _id: { $in: ids } } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray();
    console.log(` ${r._id} ${String(r.status).padEnd(12)} ${r.createdAt?.toISOString?.().slice(0,10)} robot=${r.robot?.name??'?'} carts=${ids.length} sealBatches=${r.sealBatches?.length??0} cartStatuses=${JSON.stringify(Object.fromEntries(sts.map((s:any)=>[s._id,s.n])))}`);
  }
  console.log('\nSEALED CARTS by status (should be just sealed):', await carts.countDocuments({ status: 'sealed' }));
  const sealedHasTest = await carts.countDocuments({ status:'sealed', 'testResult.status': { $exists: true } });
  console.log(' sealed carts with testResult:', sealedHasTest);
  console.log('\nCARTS WITH topSeal subdoc by status:');
  const ts = await carts.aggregate([{ $match: { 'topSeal.recordedAt': { $exists: true } } }, { $group: { _id: '$status', n: { $sum: 1 }, withLot: { $sum: { $cond: [{ $gt: ['$topSeal.topSealLotId', null] }, 1, 0] } } } }, { $sort: { n: -1 } }]).toArray();
  console.table(ts);
  console.log('\nRUNS with sealBatches / cartridgesFilled.topSealBatchId:');
  console.log(' runs with sealBatches:', await runs.countDocuments({ 'sealBatches.0': { $exists: true } }));
  console.log(' runs with legacy topSeal subdoc:', await runs.countDocuments({ 'topSeal': { $exists: true } }));
  console.log(' runs with cartridgesFilled.topSealBatchId:', await runs.countDocuments({ 'cartridgesFilled.topSealBatchId': { $exists: true } }));
  console.log('\nReagent run status histogram:');
  console.table(await runs.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray());
  await mongoose.disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
