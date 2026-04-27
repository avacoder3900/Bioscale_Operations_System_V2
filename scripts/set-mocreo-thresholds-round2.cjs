/* Round 2: thresholds for the 3 non-cold sensors + correction for Small Black Freezer.
 * Small Black Freezer was previously set to -30/-2 (fridge range) but it's an
 * ultra-low freezer running ~-38°C — corrected to -45/-30.
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
const genId = () => crypto.randomBytes(8).toString('hex');

const TARGETS = [
  { mocreoDeviceId: 'MC30AEA404F16B', label: 'Cartridge Oven',      min: 40,  max: 70,  reason: 'Operating range for cartridge curing oven' },
  { mocreoDeviceId: 'MC30AEA40579FB', label: 'RO4 Opentron',        min: 18,  max: 32,  reason: 'Robot-deck ambient operating range' },
  { mocreoDeviceId: 'MC30AEA4057B15', label: 'Room Temperature',    min: 17,  max: 30,  reason: 'Ambient lab temperature operating range' },
  { mocreoDeviceId: 'MC30AEA4004F9C', label: 'Small Black Freezer', min: -45, max: -30, reason: 'Correction: ultra-low freezer (was incorrectly set to fridge range -30/-2)' }
];

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const equipment = db.collection('equipment');
  const sensorConfigs = db.collection('sensor_configs');
  const auditLog = db.collection('audit_log');

  console.log('\n=== ROUND 2 THRESHOLD UPDATES ===');
  for (const t of TARGETS) {
    const eq = await equipment.findOne({ mocreoDeviceId: t.mocreoDeviceId });
    const sc = await sensorConfigs.findOne({ _id: t.mocreoDeviceId });
    const beforeSc = sc ? { temperatureMinC: sc.temperatureMinC ?? null, temperatureMaxC: sc.temperatureMaxC ?? null } : null;
    const beforeEq = eq ? { temperatureMinC: eq.temperatureMinC ?? null, temperatureMaxC: eq.temperatureMaxC ?? null } : null;

    if (!eq) {
      console.log(`  [${t.label}] no Equipment doc — writing SensorConfig override`);
      await sensorConfigs.updateOne(
        { _id: t.mocreoDeviceId },
        { $set: { sensorName: t.label, temperatureMinC: t.min, temperatureMaxC: t.max, alertsEnabled: true, updatedAt: new Date() } },
        { upsert: true }
      );
      await auditLog.insertOne({
        _id: genId(),
        tableName: 'sensor_configs',
        recordId: t.mocreoDeviceId,
        action: 'UPDATE',
        oldData: beforeSc,
        newData: { temperatureMinC: t.min, temperatureMaxC: t.max, alertsEnabled: true },
        changedFields: {
          temperatureMinC: { from: beforeSc?.temperatureMinC ?? null, to: t.min },
          temperatureMaxC: { from: beforeSc?.temperatureMaxC ?? null, to: t.max }
        },
        changedAt: new Date(),
        changedBy: 'script:set-mocreo-thresholds-round2.cjs',
        reason: t.reason
      });
      console.log(`     before: min=${beforeSc?.temperatureMinC ?? 'null'}°C max=${beforeSc?.temperatureMaxC ?? 'null'}°C`);
      console.log(`     after:  min=${t.min}°C max=${t.max}°C`);
      continue;
    }

    await equipment.updateOne(
      { _id: eq._id },
      { $set: { temperatureMinC: t.min, temperatureMaxC: t.max, alertsEnabled: true } }
    );
    await auditLog.insertOne({
      _id: genId(),
      tableName: 'equipment',
      recordId: eq._id,
      action: 'UPDATE',
      oldData: beforeEq,
      newData: { temperatureMinC: t.min, temperatureMaxC: t.max, alertsEnabled: true },
      changedFields: {
        temperatureMinC: { from: beforeEq.temperatureMinC, to: t.min },
        temperatureMaxC: { from: beforeEq.temperatureMaxC, to: t.max }
      },
      changedAt: new Date(),
      changedBy: 'script:set-mocreo-thresholds-round2.cjs',
      reason: t.reason
    });
    console.log(`  [${t.label}] ${eq.name} (eq=${eq._id})`);
    console.log(`     before: min=${beforeEq.temperatureMinC ?? 'null'}°C max=${beforeEq.temperatureMaxC ?? 'null'}°C`);
    console.log(`     after:  min=${t.min}°C max=${t.max}°C`);
  }

  // Verification table
  console.log('\n=== POST-CHANGE VERIFICATION (full fleet) ===');
  const sensors = await db.collection('temperature_readings').aggregate([
    { $sort: { timestamp: -1 } },
    { $group: { _id: '$sensorId', name: { $first: '$sensorName' }, latestT: { $first: '$temperature' } } },
    { $sort: { name: 1 } }
  ]).toArray();
  const eqAfter = await equipment.find({ mocreoDeviceId: { $ne: null } }).toArray();
  const eqMap = new Map(eqAfter.map(e => [e.mocreoDeviceId, e]));
  const scAfter = await sensorConfigs.find().toArray();
  const scMap = new Map(scAfter.map(s => [s._id, s]));
  console.log('  sensor                    eff.min   eff.max   latest      protected?');
  for (const s of sensors) {
    const sc = scMap.get(s._id);
    const eq = eqMap.get(s._id);
    const min = sc?.temperatureMinC ?? eq?.temperatureMinC ?? null;
    const max = sc?.temperatureMaxC ?? eq?.temperatureMaxC ?? null;
    const protectedFlag = (min != null || max != null) ? 'YES' : '** NO **';
    const inRange = (s.latestT != null && min != null && s.latestT < min) ? '  ⚠ BELOW MIN'
                  : (s.latestT != null && max != null && s.latestT > max) ? '  ⚠ ABOVE MAX'
                  : '';
    console.log(`  ${(s.name || '?').padEnd(24)}  ${String(min ?? '-').padStart(7)}  ${String(max ?? '-').padStart(7)}   ${String(s.latestT ?? '-').padStart(6)}°C   ${protectedFlag}${inRange}`);
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
