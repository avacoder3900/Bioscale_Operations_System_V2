/* One-off: investigate weekend Mocreo outage.
 * Reads .env from cwd, queries temperature_readings + temperature_alerts.
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
if (!uri) { console.error('No MONGODB_URI'); process.exit(1); }

const fmt = (d) => d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '(none)';

(async () => {
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  const readings = db.collection('temperature_readings');
  const alerts = db.collection('temperature_alerts');

  // 1) Latest reading per sensor — figure out which sensors are stale
  const latestPerSensor = await readings.aggregate([
    { $sort: { timestamp: -1 } },
    { $group: {
        _id: '$sensorId',
        sensorName: { $first: '$sensorName' },
        latest: { $first: '$timestamp' },
        equipmentId: { $first: '$equipmentId' },
        temperature: { $first: '$temperature' }
    }},
    { $sort: { latest: 1 } }
  ]).toArray();

  console.log('\n=== LATEST READING PER SENSOR (oldest first) ===');
  const now = Date.now();
  for (const r of latestPerSensor) {
    const ageMin = Math.round((now - new Date(r.latest).getTime()) / 60000);
    const ageStr = ageMin > 1440 ? `${Math.round(ageMin/1440)}d` : ageMin > 60 ? `${Math.round(ageMin/60)}h` : `${ageMin}m`;
    console.log(`  ${fmt(r.latest)}  age=${ageStr.padStart(6)}  ${r.sensorName} (${r._id})  ${r.temperature ?? '?'}°C`);
  }

  // 2) Reading-count pivot by day for last 14 days — pipeline cliff vs probe drop
  const since = new Date(now - 14 * 24 * 3600 * 1000);
  const dailyCounts = await readings.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $group: {
        _id: { day: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, sensorId: '$sensorId' },
        count: { $sum: 1 }
    }},
    { $group: {
        _id: '$_id.day',
        totalReadings: { $sum: '$count' },
        sensorsWithReadings: { $sum: 1 }
    }},
    { $sort: { _id: 1 } }
  ]).toArray();

  console.log('\n=== READINGS PER DAY (last 14d) — pipeline cliff if total drops together ===');
  console.log('  date         total   sensors');
  for (const d of dailyCounts) {
    console.log(`  ${d._id}  ${String(d.totalReadings).padStart(5)}    ${String(d.sensorsWithReadings).padStart(2)}`);
  }

  // 3) Hourly counts for the last 5 days — find the exact gap
  const since5 = new Date(now - 5 * 24 * 3600 * 1000);
  const hourly = await readings.aggregate([
    { $match: { timestamp: { $gte: since5 } } },
    { $group: {
        _id: { $dateToString: { format: '%Y-%m-%d %H:00', date: '$timestamp' } },
        count: { $sum: 1 },
        sensors: { $addToSet: '$sensorId' }
    }},
    { $sort: { _id: 1 } }
  ]).toArray();

  console.log('\n=== HOURLY READING COUNTS (last 5d) — gap reveals exact outage window ===');
  console.log('  hour            count   distinct-sensors');
  for (const h of hourly) {
    console.log(`  ${h._id}     ${String(h.count).padStart(4)}    ${h.sensors.length}`);
  }

  // 4) Recent lost_connection alerts (last 7d)
  const since7 = new Date(now - 7 * 24 * 3600 * 1000);
  const recentAlerts = await alerts.find({
    alertType: 'lost_connection',
    timestamp: { $gte: since7 }
  }).sort({ timestamp: -1 }).toArray();

  console.log('\n=== LOST_CONNECTION ALERTS (last 7d) ===');
  if (recentAlerts.length === 0) {
    console.log('  (none)');
  } else {
    for (const a of recentAlerts) {
      const ack = a.acknowledged ? `ACK by ${a.acknowledgedBy?.username ?? '?'} @ ${fmt(a.acknowledgedAt)}` : 'UNACKED';
      console.log(`  ${fmt(a.timestamp)}  ${a.sensorName} (${a.equipmentName ?? 'unmapped'})  ${ack}`);
    }
  }

  // 5) Total alert summary
  const allUnackedLost = await alerts.countDocuments({ alertType: 'lost_connection', acknowledged: false });
  const totalReadings = await readings.estimatedDocumentCount();
  console.log(`\n=== TOTALS === unacked lost_connection: ${allUnackedLost}  | total readings ever: ${totalReadings}`);

  await client.close();
})().catch((e) => { console.error(e); process.exit(1); });
