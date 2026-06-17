import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const db = mongoose.connection.db!;
  const allBackingLots = await db.collection('backing_lots').find({}).project({ _id: 1 }).toArray();
  const blIds = (allBackingLots as any[]).map(b => b._id);
  const lotRecs = await db.collection('lot_records').find({ bucketBarcode: { $in: blIds } }).project({ _id: 1 }).toArray();
  const known = new Set((lotRecs as any[]).map(l => l._id));
  const stubs = await db.collection('cartridge_records').find({ status: 'backing', 'backing.lotId': { $exists: true } }).project({ _id: 1, 'backing.lotId': 1 }).toArray();
  const orphanIds = (stubs as any[]).filter(c => !known.has(c.backing.lotId)).map(c => c._id);
  console.log('Orphan stub IDs to void:', orphanIds);
  if (orphanIds.length) {
    const r = await db.collection('cartridge_records').updateMany(
      { _id: { $in: orphanIds } },
      { $set: { status: 'voided', voidedAt: new Date(), voidReason: 'Orphan WI-01 placeholder — backing.lotId unmapped to any BackingLot' } }
    );
    console.log('Voided:', r.modifiedCount);
  }
  await mongoose.disconnect();
})();
