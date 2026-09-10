import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const spus = db.collection('spus');
  console.log('total', await spus.countDocuments());
  console.log('byStatus', await spus.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { _id: 1 } }]).toArray());
  console.log('byAssignmentType', await spus.aggregate([{ $group: { _id: '$assignment.type', n: { $sum: 1 } } }]).toArray());
  console.log('byLocation', await spus.aggregate([{ $group: { _id: '$location', n: { $sum: 1 } } }]).toArray());
  console.log('withParticle', await spus.countDocuments({ 'particleLink.particleDeviceId': { $exists: true, $ne: null } }));
  console.log('withParticle & notRetired', await spus.countDocuments({ 'particleLink.particleDeviceId': { $exists: true, $ne: null }, status: { $ne: 'retired' } }));
  console.log('research w/ particle', await spus.countDocuments({ 'assignment.type': 'research', 'particleLink.particleDeviceId': { $exists: true, $ne: null } }));
  const sample = await spus.find({ 'assignment.type': 'research' }).project({ udi: 1, status: 1, location: 1, assignment: 1 }).limit(5).toArray();
  console.log('researchSample', JSON.stringify(sample));
  const locSample = await spus.find({ location: { $exists: true, $ne: null } }).project({ udi: 1, status: 1, location: 1 }).toArray();
  console.log('locationSample', JSON.stringify(locSample));
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
