/**
 * Movement Log types (2026-11-06) — the broad groups each row's kind falls
 * in, so the log can be narrowed to "every Opentron liquid step" as well as
 * to one exact type ("Aspirate"). Pure: no DB.
 *
 * A group id carries its device ("ot2:liquid"), so picking a group also
 * picks the machine. An OT-2 kind no group names falls in "ot2:other".
 */
import type { MoveDevice } from './ot2-move-log';

export interface MoveGroup {
	id: string;
	device: MoveDevice;
	title: string;
	/** The kinds in the group; empty for the catch-all "Other". */
	kinds: string[];
}

export const MOVE_GROUPS: MoveGroup[] = [
	{ id: 'arm:servo', device: 'arm', title: 'Servo Move', kinds: ['move', 'jog'] },
	{ id: 'arm:whole', device: 'arm', title: 'Whole Arm Move', kinds: ['jog_cartesian', 'hold'] },
	{ id: 'arm:torque', device: 'arm', title: 'Torque', kinds: ['torque_on', 'torque_off'] },
	{ id: 'arm:playback', device: 'arm', title: 'Playback', kinds: ['play', 'record', 'leader', 'task'] },
	{ id: 'arm:loop', device: 'arm', title: 'Loop Step', kinds: ['loop_step'] },
	{ id: 'arm:stop', device: 'arm', title: 'Stop', kinds: ['stop'] },
	{
		id: 'ot2:movement',
		device: 'ot2',
		title: 'Movement',
		kinds: ['moveToWell', 'moveToCoordinates', 'moveRelative', 'moveToAddressableArea', 'moveToAddressableAreaForDropTip', 'home', 'retractAxis', 'moveLabware']
	},
	{
		id: 'ot2:liquid',
		device: 'ot2',
		title: 'Liquid',
		kinds: ['aspirate', 'dispense', 'aspirateInPlace', 'dispenseInPlace', 'blowout', 'blowOut', 'blowOutInPlace', 'touchTip', 'mix', 'airGapInPlace', 'prepareToAspirate']
	},
	{ id: 'ot2:tips', device: 'ot2', title: 'Tips', kinds: ['pickUpTip', 'dropTip', 'dropTipInPlace'] },
	{ id: 'ot2:wait', device: 'ot2', title: 'Wait', kinds: ['waitForDuration', 'waitForResume', 'delay'] },
	{
		id: 'ot2:setup',
		device: 'ot2',
		title: 'Setup',
		kinds: ['loadLabware', 'reloadLabware', 'loadPipette', 'loadModule', 'loadLiquid', 'configureForVolume', 'configureNozzleLayout', 'setRailLights']
	},
	{ id: 'ot2:comment', device: 'ot2', title: 'Comment', kinds: ['comment'] },
	{ id: 'ot2:other', device: 'ot2', title: 'Other', kinds: [] }
];

const BY_ID = new Map(MOVE_GROUPS.map((g) => [g.id, g]));

export const moveGroup = (id: string | null | undefined): MoveGroup | null => (id ? (BY_ID.get(id) ?? null) : null);

/** The group a row's kind falls in. Arm kinds are all named; an unnamed OT-2 kind is Other. */
export function groupOfKind(device: string | null | undefined, kind: string): MoveGroup | null {
	const d: MoveDevice = device === 'ot2' ? 'ot2' : 'arm';
	return MOVE_GROUPS.find((g) => g.device === d && g.kinds.includes(kind)) ?? (d === 'ot2' ? BY_ID.get('ot2:other')! : null);
}

/** Mongo condition on `kind` for a group: its kinds, or for Other every OT-2 kind no group names. */
export function groupKindQuery(g: MoveGroup): { $in: string[] } | { $nin: string[] } {
	if (g.kinds.length) return { $in: g.kinds };
	return { $nin: MOVE_GROUPS.filter((x) => x.device === g.device).flatMap((x) => x.kinds) };
}
