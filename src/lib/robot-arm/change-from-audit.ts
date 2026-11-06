/**
 * Robot arm Change Log rows from the BIMS audit trail (2026-11-06).
 *
 * The arm's settings and the OT-2 work done for the arm were audited
 * (audit_log) but never reached the Change Log: the Run tab's Setup and
 * robot switch, Stage Calibration's scan position, dispense depth, stage
 * edits and tip calibrator, protocol deploys and library replaces, the
 * conveyor default, the tunnel address and the old droop trims. Each audit
 * row maps to zero or more labelled changes here; the live routes write them
 * beside their audit row and scripts/backfill-arm-changes-from-audit.ts
 * writes the past ones. Pure: no DB.
 *
 * Teach edits (poses, move sets, sequences) stay in the audit trail only:
 * they are the work taught on the arm, not changes to it.
 */
import type { ArmChangeLabel, ArmSource } from './change-labels';

export interface AuditRowLike {
	_id: string;
	action: string;
	tableName: string;
	recordId: string;
	oldData?: Record<string, unknown> | null;
	newData?: Record<string, unknown> | null;
}

export interface AuditNames {
	/** OT-2 name by id ("Robot 3 B07"). */
	robots: Record<string, string>;
	/** Protocol file name by library id. */
	protocols?: Record<string, string>;
}

export interface AuditChange extends ArmChangeLabel {
	source: ArmSource;
	note?: string | null;
}

/** The audit actions this file reads (the generic 'deploy' only for opentrons_protocols). */
export const AUDIT_CHANGE_ACTIONS = new Set([
	'arm_wax_fill.setup',
	'arm_wax_fill.switch_robot',
	'arm_wax_fill.scan_position',
	'arm_wax_fill.dispense_depth',
	'arm_wax_fill.stage_edit',
	'arm_wax_fill.calibrator',
	'arm_wax_fill.deploy_protocol',
	'arm_wax_fill.library_replace',
	'deploy',
	'robot_arm.conveyor.default',
	'robot_arm.animate.pose_droop_settle',
	'robot_arm.animate.pose_droop_clear',
	'robot_arm.animate.pose_droop_clear_all',
	'robot_arm.animate.pose_droop_purged',
	'UPDATE'
]);

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const r2 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 100) / 100 : null);

/** "B07" from "Robot 3 B07"; the name when it has no slot; the id when the robot is unknown. */
export function robotSlot(id: unknown, names: AuditNames): string {
	const name = names.robots[String(id ?? '')] ?? '';
	return /\b([A-Z]\d{2})\b/.exec(name)?.[1] ?? (name || String(id ?? ''));
}

/** "220.18, 248.05, 167.75" for a point, null for none. */
export function pointText(p: unknown): string | null {
	const o = obj(p);
	if (!o) return null;
	const xyz = [r2(o.x), r2(o.y), r2(o.z)];
	return xyz.some((v) => v == null) ? null : xyz.join(', ');
}

/** "C, A" from { c: true, b: false, a: true }. */
const channelsText = (v: unknown): string | null => {
	const o = obj(v);
	if (!o) return null;
	return (['c', 'b', 'a'] as const).filter((k) => o[k] === true).map((k) => k.toUpperCase()).join(', ') || 'None';
};

const host = (url: unknown): string | null => {
	if (typeof url !== 'string' || !url) return null;
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Run tab Setup fields as Change Log keys; `show` turns the stored value into what the log prints. */
const SETUP_FIELDS: { field: string; key: string; hardware: 'ot2' | 'stage' | 'network' | 'gripper'; show?: (v: unknown, n: AuditNames) => unknown }[] = [
	{ field: 'robotId', key: 'setup.robot', hardware: 'ot2', show: (v, n) => (v ? robotSlot(v, n) : null) },
	{ field: 'cartPosition', key: 'setup.cart_position', hardware: 'stage' },
	{ field: 'waxSourceLot', key: 'setup.wax_source_lot', hardware: 'stage' },
	{ field: 'testMode', key: 'setup.test_mode', hardware: 'stage' },
	{ field: 'channels', key: 'setup.channels', hardware: 'stage', show: channelsText },
	{ field: 'chainGrab', key: 'setup.chain_grab', hardware: 'gripper' },
	{ field: 'grabDuringProbe', key: 'setup.grab_during_probe', hardware: 'gripper' },
	{ field: 'useArmLink', key: 'setup.use_arm_link', hardware: 'network' },
	{ field: 'scanPresenceOnly', key: 'setup.scan_presence_only', hardware: 'stage' }
];

/** The labelled changes one audit row stands for; [] when it is not an arm change. */
export function changesFromAudit(a: AuditRowLike, names: AuditNames): AuditChange[] {
	const d = a.newData ?? {};
	const before = obj(d.before);
	const robot = robotSlot(a.recordId, names);
	switch (a.action) {
		case 'arm_wax_fill.setup': {
			const out: AuditChange[] = [];
			for (const f of SETUP_FIELDS) {
				if (!(f.field in d)) continue;
				const oldRaw = before ? before[f.field] : undefined;
				if (before && same(oldRaw, d[f.field])) continue;
				const show = f.show ?? ((v: unknown) => v);
				out.push({ page: 'run', hardware: f.hardware, key: f.key, oldValue: before ? show(oldRaw, names) : null, newValue: show(d[f.field], names) ?? 'None', source: 'ui' });
			}
			return out;
		}
		case 'arm_wax_fill.switch_robot':
			return [{ page: 'run', hardware: 'ot2', key: 'setup.robot', oldValue: before?.robotId ? robotSlot(before.robotId, names) : null, newValue: robotSlot(d.robotId, names), source: 'ui' }];
		case 'arm_wax_fill.scan_position':
			return [{ page: 'calibrate.stage', hardware: 'stage', key: 'stage.scan_position', target: `robot:${robot}`, oldValue: pointText(d.before), newValue: pointText(d) ?? 'Cleared', unit: pointText(d) ? 'mm' : null, source: 'ui' }];
		case 'arm_wax_fill.dispense_depth':
			return [{ page: 'calibrate.stage', hardware: 'stage', key: 'stage.dispense_depth', target: `robot:${robot}`, oldValue: r2(d.before), newValue: r2(d.mm), unit: 'mm', source: 'ui' }];
		case 'arm_wax_fill.stage_edit': {
			const label = typeof d.label === 'string' ? d.label : null;
			if (d.mode === 'translate') {
				return [{ page: 'calibrate.stage', hardware: 'stage', key: 'stage.cart_location', target: `robot:${robot}`, oldValue: pointText(d.cartLocationBefore), newValue: pointText(d.cartLocationAfter), unit: 'mm', source: 'ui', note: label }];
			}
			const edits = Array.isArray(d.edits) ? (d.edits as Record<string, unknown>[]) : [];
			return edits.map((e) => ({
				page: 'calibrate.stage' as const,
				hardware: 'stage' as const,
				key: 'stage.hole_offset',
				target: `robot:${robot} hole:${String(e.wellName ?? '?')}`,
				newValue: `dx ${r2(e.dx) ?? 0} dy ${r2(e.dy) ?? 0} dz ${r2(e.dz) ?? 0}`,
				unit: 'mm',
				source: 'ui' as const,
				note: label
			}));
		}
		case 'arm_wax_fill.calibrator': {
			const out: AuditChange[] = [];
			const target = `robot:${robot}`;
			const page = 'calibrate.stage' as const;
			const pos = pointText(d.position);
			const posBefore = pointText(before?.position);
			if (!before || pos !== posBefore) out.push({ page, hardware: 'stage', key: 'calibrator.position', target, oldValue: posBefore, newValue: pos, unit: 'mm', source: 'ui' });
			for (const [field, profile] of [['zCalWax', 'wax'], ['zCalReagent', 'reagent']] as const) {
				if (!(field in d)) continue;
				if (before && same(r2(before[field]), r2(d[field]))) continue;
				out.push({ page, hardware: 'stage', key: 'calibrator.probe_z', target: `${target} tip:${profile}`, oldValue: before ? r2(before[field]) : null, newValue: r2(d[field]), unit: 'mm', source: 'ui' });
			}
			if ('maxTipAdjust' in d && !same(before ? r2(before.maxTipAdjust) : null, r2(d.maxTipAdjust))) {
				out.push({ page, hardware: 'stage', key: 'calibrator.max_tip_adjust', target, oldValue: before ? r2(before.maxTipAdjust) : null, newValue: r2(d.maxTipAdjust), unit: 'mm', source: 'ui' });
			}
			return out;
		}
		case 'arm_wax_fill.deploy_protocol':
			return [{ page: 'run', hardware: 'ot2', key: 'ot2.protocol', target: `robot:${robot}`, newValue: String(d.fileName ?? 'Unknown'), source: 'ui', note: d.rehearsal ? 'Rehearsal' : null }];
		case 'deploy': {
			// The arm's own deploys come as arm_wax_fill.deploy_protocol (its 'deploy' row is the same deploy).
			if (a.tableName !== 'opentrons_protocols' || d.from === 'arm-wax-fill') return [];
			const file = names.protocols?.[a.recordId] ?? a.recordId;
			const status = typeof d.analysisStatus === 'string' ? d.analysisStatus : null;
			return [{ page: 'opentrons', hardware: 'ot2', key: 'ot2.protocol', target: `robot:${robotSlot(d.robotId, names)}`, newValue: file, source: 'ui', note: status && status !== 'completed' ? `Analysis ${status}` : null }];
		}
		case 'arm_wax_fill.library_replace': {
			const hash8 = typeof d.fileHash === 'string' ? d.fileHash.slice(0, 8) : '';
			const archived = Array.isArray(d.archived) ? (d.archived as Record<string, unknown>[]).map((x) => String(x.fileHash ?? '').slice(0, 8)).filter(Boolean) : [];
			return [{ page: 'run', hardware: 'ot2', key: 'ot2.protocol_library', target: typeof d.fileName === 'string' ? `file:${d.fileName}` : null, oldValue: archived.length ? archived.join(', ') : null, newValue: hash8 || 'Added', source: 'ui', note: d.reused ? 'Same file already in the library' : null }];
		}
		case 'robot_arm.conveyor.default':
			return [{ page: 'teach', hardware: 'conveyor', key: 'conveyor.default_ms', oldValue: obj(a.oldData)?.conveyorPulseMs ?? null, newValue: d.conveyorPulseMs ?? null, unit: 'ms', source: 'ui' }];
		case 'robot_arm.animate.pose_droop_settle':
			return Array.isArray(d.trim)
				? [{ page: 'teach', hardware: 'servo', key: 'pose.droop_trim', target: `pose:${String(d.name ?? a.recordId)}`, oldValue: Array.isArray(d.before) && d.before.length ? d.before : null, newValue: d.trim.length ? d.trim : 'None', unit: d.trim.length ? 'steps' : null, source: 'ui' }]
				: [];
		case 'robot_arm.animate.pose_droop_clear':
			return [{ page: 'teach', hardware: 'servo', key: 'pose.droop_trim', target: `pose:${String(d.name ?? a.recordId)}`, oldValue: Array.isArray(d.before) ? d.before : null, newValue: 'Cleared', unit: null, source: 'ui', note: typeof d.note === 'string' ? d.note : null }];
		case 'robot_arm.animate.pose_droop_clear_all': {
			const poses = Array.isArray(d.poses) ? (d.poses as Record<string, unknown>[]) : [];
			return poses.map((p) => ({ page: 'teach' as const, hardware: 'servo' as const, key: 'pose.droop_trim', target: `pose:${String(p.name ?? p._id)}`, oldValue: Array.isArray(p.before) ? p.before : null, newValue: 'Cleared', source: 'ui' as const, note: 'Clear All Droop' }));
		}
		case 'robot_arm.animate.pose_droop_purged':
			return [{ page: 'teach', hardware: 'servo', key: 'pose.droop_trim', target: 'pose:all', newValue: 'Purged', source: 'code', note: `${String(d.count ?? '?')} poses; droop correction removed` }];
		case 'UPDATE':
			if (a.tableName !== 'robot_arm_endpoints') return [];
			return [{ page: 'pi', hardware: 'network', key: 'network.tunnel_url', target: `endpoint:${a.recordId}`, oldValue: host(obj(a.oldData)?.url), newValue: host(d.url), source: 'pi' }];
		default:
			return [];
	}
}
