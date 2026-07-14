/**
 * Run the tip-calibrator variation test on B07 and report the statistics.
 *
 * Deliberately ISOLATED: the protocol is uploaded to the robot and run directly over the
 * robot's HTTP API. It is NEVER written into opentrons_robots.protocols, so it cannot appear
 * in a BIMS start form or be picked up by a real fill. Nothing about the wax/reagent setup
 * changes. Mongo is only read, for the labware definitions.
 *
 * THE QUESTION: is the per-tip bend calibration load-bearing, or is it noise? Tips do not sit
 * perfectly straight on the nozzle. The wax fill threads a tip into a 1.8mm hole with ~0.4mm of
 * side clearance. If tips wander more than that between pickups, the calibrator is mandatory.
 * If they don't, it is measuring nothing.
 *
 * Each tip is probed several times WITHOUT being dropped, which splits the spread in two:
 *     within-tip  = the calibrator's own repeatability (measurement noise)
 *     between-tip = real tip-to-tip variation (what the fill actually suffers)
 * A single reading per tip cannot tell those apart, and they demand opposite decisions.
 *
 *   node scripts/tipcal-variation.cjs                  # upload + run + report
 *   node scripts/tipcal-variation.cjs --report <runId> # just re-report an existing run
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const HOST = process.env.ROBOT_HOST || '172.16.28.101';   // B07
const PROTOCOL = path.resolve(__dirname, '..', 'protocols', 'Tip_Calibrator_Variation_Test.py');
const NAME = 'Tip_Calibrator_Variation_Test.py';
const H = { 'opentrons-version': '*' };

// The wax fill's fill hole is 1.8mm across; a tip has roughly this much room on each side.
const CLEARANCE_MM = 0.4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / (a.length - 1)));
const f = (n, w = 6) => (Number.isFinite(n) ? n.toFixed(2) : '  -  ').padStart(w);

async function api(p, opts = {}) {
  const res = await fetch(`http://${HOST}:31950${p}`, {
    ...opts,
    headers: { ...H, ...(opts.body && !(opts.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    signal: AbortSignal.timeout(opts.timeoutMs || 120000)
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} -> ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function fetchSamples(runId) {
  const rows = [];
  let cursor = 0;
  for (;;) {
    const page = await api(`/runs/${runId}/commands?cursor=${cursor}&pageLength=500`);
    const cmds = page?.data ?? [];
    if (!cmds.length) break;
    for (const c of cmds) {
      if (c.commandType !== 'comment') continue;
      const m = /TIPCAL SAMPLE tip=(\S+) idx=(\d+) rep=(\d+) shift_x=(\S+) shift_y=(\S+)/.exec(String(c.params?.message ?? ''));
      if (m) rows.push({ tip: m[1], idx: +m[2], rep: +m[3], x: m[4] === 'MISS' ? null : +m[4], y: m[5] === 'MISS' ? null : +m[5] });
    }
    const total = page?.meta?.totalLength ?? cmds.length;
    cursor += cmds.length;
    if (cursor >= total) break;
  }
  return rows;
}

function report(rows) {
  if (!rows.length) { console.log('\nNo TIPCAL samples found — the run produced no probes.'); return; }

  const byTip = new Map();
  for (const r of rows) {
    if (!byTip.has(r.tip)) byTip.set(r.tip, []);
    byTip.get(r.tip).push(r);
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`TIP CALIBRATOR VARIATION — ${byTip.size} tips, ${rows.length} probes  (robot ${HOST})`);
  console.log('='.repeat(78));
  console.log('\nRaw shift = how far the tip travelled before closing the limit switch, i.e. where');
  console.log('the tip actually is. Probe resolution is 0.1mm.\n');
  console.log('  tip     n     mean_x   sd_x     mean_y   sd_y    <- sd here = CALIBRATOR NOISE');
  console.log('  ' + '-'.repeat(62));

  const tipMeanX = [], tipMeanY = [], withinSdX = [], withinSdY = [];
  const misses = rows.filter((r) => r.x === null || r.y === null).length;

  for (const [tip, rs] of byTip) {
    const xs = rs.map((r) => r.x).filter((v) => v !== null);
    const ys = rs.map((r) => r.y).filter((v) => v !== null);
    if (xs.length) { tipMeanX.push(mean(xs)); if (xs.length > 1) withinSdX.push(sd(xs)); }
    if (ys.length) { tipMeanY.push(mean(ys)); if (ys.length > 1) withinSdY.push(sd(ys)); }
    console.log(`  ${tip.padEnd(6)} ${String(rs.length).padStart(2)}   ${f(xs.length ? mean(xs) : NaN)}  ${f(xs.length > 1 ? sd(xs) : NaN)}   ${f(ys.length ? mean(ys) : NaN)}  ${f(ys.length > 1 ? sd(ys) : NaN)}`);
  }

  const rng = (a) => (a.length ? Math.max(...a) - Math.min(...a) : NaN);
  const betweenSdX = sd(tipMeanX), betweenSdY = sd(tipMeanY);
  const noiseX = withinSdX.length ? mean(withinSdX) : NaN;
  const noiseY = withinSdY.length ? mean(withinSdY) : NaN;

  console.log(`\n${'='.repeat(78)}`);
  console.log('THE DECOMPOSITION');
  console.log('='.repeat(78));
  console.log(`  CALIBRATOR NOISE   (mean spread when re-probing the SAME tip)`);
  console.log(`      X: ${f(noiseX)} mm      Y: ${f(noiseY)} mm`);
  console.log(`  TIP-TO-TIP SPREAD  (spread across tips, each tip averaged first)`);
  console.log(`      X: ${f(betweenSdX)} mm      Y: ${f(betweenSdY)} mm`);
  console.log(`  FULL RANGE across tips`);
  console.log(`      X: ${f(rng(tipMeanX))} mm      Y: ${f(rng(tipMeanY))} mm`);
  if (misses) console.log(`\n  ⚠ ${misses} probe(s) never triggered the switch within 5mm (recorded as MISS).`);

  const worst = Math.max(rng(tipMeanX) || 0, rng(tipMeanY) || 0);
  const offenders = tipMeanX.map((_, i) => Math.hypot(tipMeanX[i] - mean(tipMeanX), (tipMeanY[i] ?? 0) - mean(tipMeanY)))
    .filter((d) => d > CLEARANCE_MM).length;

  console.log(`\n${'='.repeat(78)}`);
  console.log('WHAT IT MEANS');
  console.log('='.repeat(78));
  console.log(`  A tip has ~${CLEARANCE_MM}mm of side clearance in the 1.8mm fill hole.`);
  console.log(`  Tips landing further than that from the average: ${offenders} of ${tipMeanX.length}`);
  console.log('');

  const signalX = betweenSdX > 2 * (noiseX || 0);
  const signalY = betweenSdY > 2 * (noiseY || 0);
  if (!Number.isFinite(noiseX) && !Number.isFinite(noiseY)) {
    console.log('  Only one probe per tip — cannot separate noise from real variation.');
    console.log('  Re-run with probes_per_tip >= 2.');
  } else if ((signalX || signalY) && worst > CLEARANCE_MM) {
    console.log('  VERDICT: the calibrator is measuring something REAL, and the tips vary by more');
    console.log('  than the hole can tolerate. Tip-to-tip spread clearly exceeds the calibrator\'s');
    console.log('  own noise. => Put per-tip calibration BACK into the wax fill. Removing it was');
    console.log('  the regression, and it explains why fills are intermittent: some tips fit, some');
    console.log('  do not.');
  } else if (signalX || signalY) {
    console.log('  VERDICT: tips do vary measurably, but by LESS than the hole\'s clearance.');
    console.log('  The calibrator works, yet tip spread alone should not be snapping tips.');
    console.log('  => Something else is also wrong. Keep looking (tip length / Z is next).');
  } else {
    console.log('  VERDICT: tip-to-tip spread is NOT distinguishable from the calibrator\'s own');
    console.log('  noise. The calibrator is not measuring tip bend — it is measuring itself.');
    console.log('  => Feeding it into the fill would INJECT error, not remove it. Leave it OFF and');
    console.log('  look elsewhere.');
  }
  console.log('');
}

async function main() {
  const reportOnly = process.argv.indexOf('--report');
  if (reportOnly !== -1) {
    return report(await fetchSamples(process.argv[reportOnly + 1]));
  }

  // Refuse to disturb a robot that is mid-run.
  const runs = (await api('/runs'))?.data ?? [];
  if (runs.some((r) => ['running', 'paused', 'finishing'].includes(r.status))) {
    throw new Error('Robot has an ACTIVE run — refusing to start the test.');
  }

  await mongoose.connect(MONGODB_URI);
  const defs = await mongoose.connection.db.collection('labware_definitions')
    .find({}).project({ fileName: 1, loadName: 1, definition: 1 }).toArray();
  await mongoose.disconnect();
  console.log(`Bundling ${defs.length} BIMS labware defs`);

  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(PROTOCOL)], { type: 'text/x-python' }), NAME);
  for (const d of defs) {
    const fn = (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`;
    form.append('files', new Blob([JSON.stringify(d.definition)], { type: 'application/json' }), fn);
  }

  console.log(`Uploading ${NAME} to ${HOST}`);
  const up = await api('/protocols', { method: 'POST', body: form });
  const pid = up?.data?.id;
  console.log(`  protocolId=${pid}`);

  let status = 'pending';
  for (let i = 0; i < 60 && status !== 'completed' && status !== 'failed'; i++) {
    await sleep(3000);
    const list = (await api(`/protocols/${pid}/analyses`))?.data ?? [];
    if (list.length) status = list[list.length - 1].status;
    process.stdout.write('.');
  }
  console.log(`\n  analysis: ${status}`);
  if (status !== 'completed') throw new Error('analysis did not complete');

  const run = await api('/runs', { method: 'POST', body: JSON.stringify({ data: { protocolId: pid } }) });
  const runId = run?.data?.id;
  console.log(`  runId=${runId}\n  starting…`);
  await api(`/runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ data: { actionType: 'play' } }) });

  let st = 'running', last = 0;
  for (;;) {
    await sleep(5000);
    st = (await api(`/runs/${runId}`))?.data?.status;

    // move_labware() on an OT-2 is a MANUAL move: the engine pauses and waits for a human to
    // confirm the labware was moved. A real fill never notices because the ot2-bridge daemon
    // auto-resumes that pause for BIMS. This test runs outside BIMS, so nothing does — resume
    // it here or the run hangs forever. (OT-2 has no 'resume' action; play IS resume.)
    if (st === 'paused') {
      process.stdout.write('\n  paused (off-deck labware move) — auto-resuming\n');
      await api(`/runs/${runId}/actions`, { method: 'POST', body: JSON.stringify({ data: { actionType: 'play' } }) }).catch(() => {});
      continue;
    }

    const n = (await fetchSamples(runId)).length;
    if (n !== last) { process.stdout.write(`\r  probes recorded: ${n}   `); last = n; }
    if (['succeeded', 'failed', 'stopped'].includes(st)) break;
  }
  console.log(`\n  run ${st}`);
  if (st !== 'succeeded') console.log(`  (partial data is still reported below)`);

  report(await fetchSamples(runId));
  console.log(`Re-report any time with:  node scripts/tipcal-variation.cjs --report ${runId}\n`);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
