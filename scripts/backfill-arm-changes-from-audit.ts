/**
 * Backfill the robot arm Change Log from the audit trail (2026-11-06): the
 * Run tab Setup, Stage Calibration, protocol deploys, library replaces, the
 * conveyor default, the tunnel address and the old droop trims that were
 * audited before the Change Log read them. Labels come from
 * src/lib/robot-arm/change-from-audit.ts, the same mapper the live routes use.
 *
 *   npx tsx --tsconfig tsconfig.json scripts/backfill-arm-changes-from-audit.ts            # report
 *   npx tsx --tsconfig tsconfig.json scripts/backfill-arm-changes-from-audit.ts --apply    # write
 *
 * Idempotent: ids are armchg-audit-<audit id>-<n>, the ids the live routes
 * write, so a row is never written twice. A conveyor default the live hook
 * already logged (conveyor.default_ms within 10 s) is skipped.
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { RobotArmChange } from '../src/lib/server/db/models/index.js';
import { changeLine } from '../src/lib/robot-arm/change-labels.js';
import { AUDIT_CHANGE_ACTIONS, changesFromAudit, type AuditNames, type AuditRowLike } from '../src/lib/robot-arm/change-from-audit.js';

const APPLY = process.argv.includes('--apply');

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) throw new Error('MONGODB_URI not set');
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	const audits = (await db
		.collection('audit_log')
		.find({
			// 'UPDATE' and 'deploy' are generic actions: only the tunnel's and the protocol library's are the arm's.
			$or: [
				{ action: { $in: [...AUDIT_CHANGE_ACTIONS].filter((x) => x !== 'UPDATE' && x !== 'deploy') } },
				{ action: 'UPDATE', tableName: 'robot_arm_endpoints' },
				{ action: 'deploy', tableName: 'opentrons_protocols' }
			]
		})
		.sort({ changedAt: 1 })
		.toArray()) as unknown as (AuditRowLike & { changedAt?: Date; changedBy?: string })[];
	const robots = await db.collection('opentrons_robots').find({}).project({ name: 1 }).toArray();
	const protocolIds = [...new Set(audits.filter((a) => a.action === 'deploy').map((a) => a.recordId))];
	const protocols = await db.collection('opentrons_protocols').find({ _id: { $in: protocolIds as never[] } }).project({ fileName: 1 }).toArray();
	const names: AuditNames = {
		robots: Object.fromEntries(robots.map((r) => [String(r._id), String(r.name ?? '')])),
		protocols: Object.fromEntries(protocols.map((p) => [String(p._id), String(p.fileName ?? p._id)]))
	};
	let written = 0;
	let present = 0;
	let skipped = 0;
	for (const a of audits) {
		const at = a.changedAt ? new Date(a.changedAt) : new Date();
		const changes = changesFromAudit(a, names);
		for (let i = 0; i < changes.length; i++) {
			const _id = `armchg-audit-${a._id}-${i + 1}`;
			if (await RobotArmChange.exists({ _id })) {
				present++;
				continue;
			}
			const { source, note, ...label } = changes[i];
			if (label.key === 'conveyor.default_ms') {
				const near = await RobotArmChange.exists({ key: label.key, at: { $gte: new Date(at.getTime() - 10_000), $lte: new Date(at.getTime() + 10_000) } });
				if (near) {
					skipped++;
					continue;
				}
			}
			const line = changeLine(label);
			const userId = typeof a.newData?.userId === 'string' ? a.newData.userId : null;
			const by = a.changedBy && a.changedBy !== 'system' ? { _id: userId && userId !== 'system' ? userId : undefined, username: a.changedBy } : null;
			console.log(`${APPLY ? 'write' : 'would write'}  ${at.toISOString().slice(0, 16)}  ${label.page} / ${label.hardware}  ${line}  ${by?.username ?? ''}`);
			if (!APPLY) continue;
			await RobotArmChange.create({
				_id,
				at,
				page: label.page,
				hardware: label.hardware,
				key: label.key,
				target: label.target ?? null,
				oldValue: label.oldValue ?? null,
				newValue: label.newValue ?? null,
				unit: label.unit ?? null,
				source,
				line,
				note: note ?? null,
				details: { auditId: a._id, auditAction: a.action, backfill: true },
				changedBy: by
			});
			written++;
		}
	}
	console.log(`${audits.length} audit rows: ${present} changes already present, ${skipped} already logged live, ${written} written${APPLY ? '' : ' (dry run; add --apply)'}.`);
	await mongoose.disconnect();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
