#!/usr/bin/env node
const https = require('https');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function toSampleId(t) {
  return t.startsWith('MC') ? '00' + t.slice(2).toLowerCase() + '00' : t;
}

function httpsPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'BIMS/1.0' } }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject); req.write(JSON.stringify(body)); req.end();
  });
}

function httpsGet(url, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'BIMS/1.0' } }, res => {
      let data = ''; res.on('data', d => data += d); res.on('end', () => resolve(JSON.parse(data)));
    }).on('error', reject);
  });
}

async function sync() {
  const configPath = path.join(process.env.HOME || '/Users/agent001', '.openclaw/secrets/mocreo_config.json');
  const creds = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  const db = mongoose.connection.db;

  const auth = await httpsPost('https://api.sync-sign.com/v2/oauth/token', {
    username: creds.email, password: creds.password, provider: 'mocreo'
  });
  const token = auth.data.accessToken;

  const nodes = (await httpsGet('https://api.sync-sign.com/v2/nodes', token)).data;
  
  let synced = 0;
  for (const n of nodes) {
    try {
      const resp = await httpsGet('https://api.sync-sign.com/v2/nodes/' + toSampleId(n.thingName) + '/samples?limit=1', token);
      const records = resp.data?.records || [];
      if (records.length > 0) {
        const rec = records[0];
        const temp = rec.data?.tm != null ? rec.data.tm / 100 : null;
        const hum = rec.data?.hm != null ? rec.data.hm / 100 : null;
        const timestamp = new Date(rec.time * 1000);

        // Store reading with all metadata
        await db.collection('temperature_readings').insertOne({
          sensorId: n.thingName,
          sensorName: n.name,
          temperature: temp,
          humidity: hum,
          rawTemperature: rec.data?.tm,
          rawHumidity: rec.data?.hm,
          batteryLevel: n.batteryLevel ?? null,
          signalLevel: n.signalLevel ?? null,
          onlined: n.onlined ?? null,
          lastSeen: n.lastSeen ? new Date(n.lastSeen) : null,
          model: n.model ?? 'ST5',
          firmwareVersion: n.version ?? null,
          timestamp,
          createdAt: new Date()
        });

        // Update equipment with latest data
        await db.collection('equipment').updateMany(
          { mocreoDeviceId: n.thingName },
          { $set: {
            currentTemperatureC: temp,
            lastTemperatureReadAt: new Date(),
            mocreoMeta: {
              batteryLevel: n.batteryLevel ?? null,
              signalLevel: n.signalLevel ?? null,
              onlined: n.onlined ?? null,
              lastSeen: n.lastSeen ? new Date(n.lastSeen) : null,
              model: n.model ?? 'ST5',
              firmwareVersion: n.version ?? null,
              thresholds: n.info?.temperature ? {
                minC: n.info.temperature.min != null ? n.info.temperature.min / 100 : null,
                maxC: n.info.temperature.max != null ? n.info.temperature.max / 100 : null,
                calibration: n.info.temperature.calibration ?? 0,
                alertEnabled: n.info.temperature.enableAlert ?? false
              } : null
            }
          }}
        );

        // Check temperature alerts
        const equipDocs = await db.collection('equipment').find({ mocreoDeviceId: n.thingName }).toArray();
        for (const eq of equipDocs) {
          if (temp != null) {
            if (eq.temperatureMinC != null && temp < eq.temperatureMinC) {
              await db.collection('temperature_alerts').insertOne({
                sensorId: n.thingName, sensorName: n.name,
                alertType: 'low_temp', threshold: eq.temperatureMinC, actualValue: temp,
                equipmentId: String(eq._id), equipmentName: eq.name,
                timestamp: new Date(), acknowledged: false
              });
            }
            if (eq.temperatureMaxC != null && temp > eq.temperatureMaxC) {
              await db.collection('temperature_alerts').insertOne({
                sensorId: n.thingName, sensorName: n.name,
                alertType: 'high_temp', threshold: eq.temperatureMaxC, actualValue: temp,
                equipmentId: String(eq._id), equipmentName: eq.name,
                timestamp: new Date(), acknowledged: false
              });
            }
          }
        }

        synced++;
      }
      await new Promise(r => setTimeout(r, 300));
    } catch (e) { /* skip failed sensors */ }
  }

  // Check lost connections (lastSeen > 30 min ago)
  for (const n of nodes) {
    if (n.lastSeen) {
      const lastSeenMs = typeof n.lastSeen === 'number' ? n.lastSeen : new Date(n.lastSeen).getTime();
      const minutesAgo = (Date.now() - lastSeenMs) / 60000;
      if (minutesAgo > 30) {
        const existing = await db.collection('temperature_alerts').findOne({
          sensorId: n.thingName, alertType: 'lost_connection', acknowledged: false
        });
        if (!existing) {
          await db.collection('temperature_alerts').insertOne({
            sensorId: n.thingName, sensorName: n.name,
            alertType: 'lost_connection', actualValue: Math.round(minutesAgo),
            timestamp: new Date(), acknowledged: false
          });
        }
      }
    }
  }
  
  console.log(`Mocreo sync: ${synced}/${nodes.length} sensors updated`);
  await mongoose.disconnect();
  process.exit(0);
}

sync().catch(e => { console.error('Mocreo sync failed:', e.message); process.exit(1); });
