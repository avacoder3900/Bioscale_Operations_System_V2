/* Backfill temperature thresholds for cold-storage Mocreo sensors.
 * Fridges: 0 to 12°C, Freezers: -30 to -2°C.
 * Writes to Equipment (natural home) + AuditLog row per change.
 * Skips Cartridge Oven, RO4 Opentron, Room Temperature — operating ranges TBD.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const uri = env.MONGODB_URI || process.env.MONGODB_URI;

// matches generateId() — 16 hex chars, similar shape to other audit IDs in the DB
const genId = () => crypto.randomBytes(8).toString('hex');

const TARGETS = [
  // Fridges → 0 to 12°C
  { mocreoDeviceId: 'MC30AEA400503A', label: 'CLIA Fridge',          kind: 'fridge',  min: 0,   max: 12 },
  { mocreoDeviceId: 'MC30AEA4004882', label: 'Manufacturing Fridge', kind: 'fridge',  min: 0,   max: 12 },
  { mocreoDeviceId: 'MC30AEA404F2D2', label: 'Mini Fridge',          kind: 'fridge',  min: 0,   max: 12 },
  { mocreoDeviceId: 'MC30AEA40052FE', label: 'R&D Lab Fridge',       kind: 'fridge',  min: 0,   max: 12 },
  // Freezers → -30 to -2°C
  { mocreoDeviceId: 'MC30AEA4004617', label: 'CLIA Freezer',         kind: 'freezer', min: -30, max: -2 },
  { mocreoDeviceId: 'MC30AEA4005AA0', label: 'Manufacturing Freezr', kind: 'freezer', min: -30, max: -2 },
  { mocreoDeviceId: 'MC30AEA40090EE', label: 'R&D Freezer',          kind: 'freezer', min: -30, max: -2 },
  { mocreoDeviceId: 'MC30AEA4004F9C', label: 'Small Black Freezer',  kind: 'freezer', min: -30, max: -2 }
];

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const equipment = db.collection('equipment');
  const sensorConfigs = db.collection('sensor_configs');
  const auditLog = db.collection('audit_log');

  console.log('\n=== BACKFILLING THRESHOLDS ===');
  for (const t of TARGETS) {
    const eq = await equipment.findOne({ mocreoDeviceId: t.mocreoDeviceId });
    const before = eq
      ? { temperatureMinC: eq.temperatureMinC ?? null, temperatureMaxC: eq.temperatureMaxC ?? null, alertsEnabled: eq.alertsEnabled }
      : null;

    if (!eq) {
      // No Equipment doc — fall back to SensorConfig (which the sync also reads)
      console.log(`  [${t.label}] NO Equipment doc found — writing SensorConfig override instead`);
      await sensorConfigs.updateOne(
        { _id: t.mocreoDeviceId },
        {
          $set: {
            sensorName: t.label,
            temperatureMinC: t.min,
            temperatureMaxC: t.max,
            alertsEnabled: true,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );
      await auditLog.insertOne({
        _id: genId(),
        tableName: 'sensor_configs',
        recordId: t.mocreoDeviceId,
        action: 'UPDATE',
        oldData: null,
        newData: { temperatureMinC: t.min, temperatureMaxC: t.max, alertsEnabled: true },
        changedFields: { temperatureMinC: t.min, temperatureMaxC: t.max },
        changedAt: new Date(),
        changedBy: 'script:set-mocreo-thresholds.cjs',
        reason: `Backfill thresholds after 2026-04-25 power-loss revealed ${t.label} had no temp alerting configured`
      });
      console.log(`     → SensorConfig set: min=${t.min}°C max=${t.max}°C`);
      continue;
    }

    // Update Equipment doc
    const update = {
      temperatureMinC: t.min,
      temperatureMaxC: t.max,
      alertsEnabled: true
    };
    await equipment.updateOne({ _id: eq._id }, { $set: update });

    await auditLog.insertOne({
      _id: genId(),
      tableName: 'equipment',
      recordId: eq._id,
      action: 'UPDATE',
      oldData: before,
      newData: update,
      changedFields: {
        temperatureMinC: { from: before.temperatureMinC, to: t.min },
        temperatureMaxC: { from: before.temperatureMaxC, to: t.max },
        alertsEnabled: { from: before.alertsEnabled, to: true }
      },
      changedAt: new Date(),
      changedBy: 'script:set-mocreo-thresholds.cjs',
      reason: `Backfill thresholds after 2026-04-25 power-loss revealed ${t.label} had no temp alerting configured`
    });

    console.log(`  [${t.label}]  ${eq.name} (eq=${eq._id})`);
    console.log(`     before:  min=${before.temperatureMinC ?? 'null'}°C  max=${before.temperatureMaxC ?? 'null'}°C  alertsEnabled=${before.alertsEnabled}`);
    console.log(`     after:   min=${t.min}°C  max=${t.max}°C  alertsEnabled=true`);
  }

  // Verify by re-reading and showing the threshold table again
  console.log('\n=== POST-CHANGE VERIFICATION ===');
  const sensors = await db.collection('temperature_readings').aggregate([
    { $sort: { timestamp: -1 } },
    { $group: { _id: '$sensorId', name: { $first: '$sensorName' } } },
    { $sort: { name: 1 } }
  ]).toArray();
  const eqAfter = await equipment.find({ mocreoDeviceId: { $ne: null } }).toArray();
  const eqMap = new Map(eqAfter.map(e => [e.mocreoDeviceId, e]));
  const scAfter = await sensorConfigs.find().toArray();
  const scMap = new Map(scAfter.map(s => [s._id, s]));
  console.log('  sensor                    eff.min   eff.max   protected?');
  for (const s of sensors) {
    const sc = scMap.get(s._id);
    const eq = eqMap.get(s._id);
    const min = sc?.temperatureMinC ?? eq?.temperatureMinC ?? null;
    const max = sc?.temperatureMaxC ?? eq?.temperatureMaxC ?? null;
    const protectedFlag = (min != null || max != null) ? 'YES' : '** NO **';
    console.log(`  ${(s.name || '?').padEnd(24)}  ${String(min ?? '-').padStart(7)}  ${String(max ?? '-').padStart(7)}   ${protectedFlag}`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
