/**
 * Overwrite the STORED wax protocol .py (OpentronProtocol, isActive) with the current
 * working-tree protocols/Reagent_Filling_GEN7.py.
 *
 * The run-start auto-resync rebuilds the run protocol from THIS stored file, so the
 * default max_tip_adjust (now -1.0 in the working tree) only sticks if it's set here —
 * otherwise the resync keeps reverting to the stored file's old default (1.0).
 * Unlike update-stored-wax-py-dispense-depth.cjs, this always overwrites (no skip).
 *
 * Backs up the previous fileContent and audit-logs. Reversible from the backup.
 *
 *   node scripts/set-stored-wax-py.cjs
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const NEW_PY = fs.readFileSync(path.resolve(__dirname, '..', 'protocols', 'Reagent_Filling_GEN7.py'), 'utf8');
const BK = path.resolve(__dirname, '..', 'calibration-backups');

(async () => {
  const m = NEW_PY.match(/variable_name="max_tip_adjust"[\s\S]{0,220}?default=(-?[0-9.]+)/);
  const ddDefault = m ? m[1] : '(not found)';
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const c = db.collection('opentrons_protocols');
  const doc = await c.findOne({ processType: 'reagent-filling', isActive: true });
  if (!doc) throw new Error('no active wax OpentronProtocol found');

  fs.mkdirSync(BK, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const bkfile = path.join(BK, `stored-wax-py-preimage-${stamp}.py`);
  fs.writeFileSync(bkfile, doc.fileContent ?? '');

  const oldM = (doc.fileContent || '').match(/variable_name="max_tip_adjust"[\s\S]{0,220}?default=(-?[0-9.]+)/);
  console.log(`stored .py ${doc._id}: max_tip_adjust default ${oldM ? oldM[1] : '?'} -> ${ddDefault}; size ${(doc.fileContent||'').length} -> ${NEW_PY.length} bytes`);
  if ((doc.fileContent || '') === NEW_PY) { console.log('Already identical — nothing to do.'); await mongoose.disconnect(); return; }

  const r = await c.updateOne({ _id: doc._id }, { $set: { fileContent: NEW_PY, updatedAt: new Date() } });
  console.log(`update: matched=${r.matchedCount} modified=${r.modifiedCount}`);
  await db.collection('audit_log').insertOne({
    _id: 'al-' + Math.random().toString(36).slice(2, 18),
    tableName: 'opentrons_protocols', recordId: String(doc._id), action: 'UPDATE',
    changedBy: 'set-stored-wax-py', changedAt: new Date(),
    reason: `Sync stored wax .py to working tree so the run-start auto-resync stops reverting the max_tip_adjust default (now ${ddDefault}) to the old value`,
    newData: { dispenseDepthDefault: ddDefault, bytes: NEW_PY.length }
  });
  console.log(`pre-image saved: ${bkfile}`);
  console.log('\nDONE. The auto-resync will now rebuild with max_tip_adjust default = ' + ddDefault + '.');
  await mongoose.disconnect();
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
