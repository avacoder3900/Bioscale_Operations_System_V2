/* One-off: check why R&D Fridge / R&D Freezer didn't alert during weekend power-loss.
 * Inspects threshold config + actual temperature trace during outage window.
 */
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const envPath = path.join(__dirname, '..', '.env');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}
const uri = env.MONGODB_URI || process.env.MONGODB_URI;

const fmt = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '(none)';

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();

  // 1) Threshold config for ALL sensors — see which are unprotected
  console.log('\n=== THRESHOLD CONFIG: SensorConfig + Equipment fallback ===');
  console.log('  sensorId                  name                       sc.min  sc.max  eq.min  eq.max  alertsEnabled  effective');
  const sensors = await db.collection('temperature_readings').aggregate([
    { $sort: { timestamp: -1 } },
    { $group: { _id: '$sensorId', name: { $first: '$sensorName' }, equipmentId: { $first: '$equipmentId' } } },
    { $sort: { name: 1 } }
  ]).toArray();

  const sensorConfigs = await db.collection('sensor_configs').find().toArray();
  const scMap = new Map(sensorConfigs.map(s => [s._id, s]));
  const equipment = await db.collection('equipment').find({ mocreoDeviceId: { $ne: null } }).toArray();
  const eqMap = new Map(equipment.map(e => [e.mocreoDeviceId, e]));

  for (const s of sensors) {
    const sc = scMap.get(s._id);
    const eq = eqMap.get(s._id);
    const scMin = sc?.temperatureMinC;
    const scMax = sc?.temperatureMaxC;
    const eqMin = eq?.temperatureMinC;
    const eqMax = eq?.temperatureMaxC;
    const alertsEnabled = sc?.alertsEnabled ?? true;
    const effMin = scMin ?? eqMin ?? null;
    const effMax = scMax ?? eqMax ?? null;
    const protectedFlag = (alertsEnabled && (effMin != null || effMax != null)) ? 'YES' : '** NO **';
    const fmt5 = (v) => v == null ? '   -  ' : String(v).padStart(6);
    console.log(`  ${s._id}  ${(s.name || '?').padEnd(24)}  ${fmt5(scMin)}  ${fmt5(scMax)}  ${fmt5(eqMin)}  ${fmt5(eqMax)}  ${alertsEnabled ? 'on ' : 'OFF'}            ${protectedFlag}  (eff min=${effMin ?? '-'} max=${effMax ?? '-'})`);
  }

  // 2) Temperature trace for R&D Fridge + R&D Freezer over outage window
  const rdFridgeId = 'MC30AEA40052FE';
  const rdFreezerId = 'MC30AEA40090EE';
  const cliaFridgeId = 'MC30AEA400503A'; // for comparison — did it alert?
  const since = new Date('2026-04-25T00:00:00Z');
  const until = new Date('2026-04-27T18:00:00Z');

  for (const [label, id] of [['R&D Lab Fridge', rdFridgeId], ['R&D Freezer', rdFreezerId], ['CLIA Fridge (comparison)', cliaFridgeId]]) {
    console.log(`\n=== ${label} (${id}) — temperature trace 04-25 00:00 → 04-27 18:00 UTC ===`);
    const trace = await db.collection('temperature_readings').find({
      sensorId: id,
      timestamp: { $gte: since, $lte: until }
    }).sort({ timestamp: 1 }).toArray();

    let lastShown = null;
    let prevTemp = null;
    let peakTemp = -Infinity, peakAt = null;
    let minTemp = Infinity, minAt = null;
    for (const r of trace) {
      if (r.temperature > peakTemp) { peakTemp = r.temperature; peakAt = r.timestamp; }
      if (r.temperature < minTemp) { minTemp = r.temperature; minAt = r.timestamp; }
      // Only print samples where temp changed by >=0.5°C OR every ~hour
      const ts = r.timestamp.getTime();
      if (lastShown == null || ts - lastShown > 30 * 60 * 1000 || (prevTemp != null && Math.abs(r.temperature - prevTemp) >= 1)) {
        console.log(`  ${fmt(r.timestamp)}  ${String(r.temperature).padStart(7)}°C`);
        lastShown = ts;
      }
      prevTemp = r.temperature;
    }
    console.log(`  -- range over window: min=${minTemp}°C @ ${fmt(minAt)}  max=${peakTemp}°C @ ${fmt(peakAt)}  (n=${trace.length})`);
  }

  // 3) ALL alerts for these sensors in the window
  console.log(`\n=== ALL ALERTS for R&D Fridge + R&D Freezer (last 7d) ===`);
  const since7 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const alerts = await db.collection('temperature_alerts').find({
    sensorId: { $in: [rdFridgeId, rdFreezerId] },
    timestamp: { $gte: since7 }
  }).sort({ timestamp: 1 }).toArray();
  if (alerts.length === 0) {
    console.log('  (none — no high_temp / low_temp / lost_connection alerts ever fired for either sensor)');
  } else {
    for (const a of alerts) {
      console.log(`  ${fmt(a.timestamp)}  ${a.sensorName}  ${a.alertType}  threshold=${a.threshold} actual=${a.actualValue}  ack=${a.acknowledged}`);
    }
  }

  // 4) Did R&D Fridge / Freezer have continuous data through the weekend? Or were they OFFLINE?
  // If the building lost power, the probes themselves run on battery — they should keep reporting.
  // If the fridge didn't restart, the probes inside would just report a rising temperature.
  console.log(`\n=== READING CADENCE for R&D sensors during weekend (gaps reveal probe-vs-fridge) ===`);
  for (const [label, id] of [['R&D Lab Fridge', rdFridgeId], ['R&D Freezer', rdFreezerId]]) {
    const hourly = await db.collection('temperature_readings').aggregate([
      { $match: { sensorId: id, timestamp: { $gte: since, $lte: until } } },
      { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } },
        n: { $sum: 1 },
        avgT: { $avg: '$temperature' },
        maxT: { $max: '$temperature' }
      }},
      { $sort: { _id: 1 } }
    ]).toArray();
    console.log(`  --- ${label} ---`);
    for (const h of hourly) {
      console.log(`    ${h._id}  n=${String(h.n).padStart(2)}  avg=${h.avgT.toFixed(2)}°C  max=${h.maxT}°C`);
    }
  }

  await client.close();
})().catch(e => { console.error(e); process.exit(1); });
