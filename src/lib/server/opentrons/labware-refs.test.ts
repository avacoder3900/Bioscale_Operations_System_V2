import { describe, expect, it } from 'vitest';
import { labwareNamesReferencedBy } from './labware-refs';

describe('labwareNamesReferencedBy', () => {
	it('finds literal load_labware calls and ignores commented-out ones', () => {
		const src = [
			"tuberack = protocol.load_labware('cosmas_and_damian_drybath_tuberack', 10)",
			"# old = protocol.load_labware('gen4deck_gen7cartridge_005', 1)",
			"tiprack = protocol.load_labware(load_name='cosmasanddamian_96_tiprack_20ul', location=11)"
		].join('\n');
		expect(labwareNamesReferencedBy(src).sort()).toEqual(['cosmas_and_damian_drybath_tuberack', 'cosmasanddamian_96_tiprack_20ul']);
	});

	it('resolves a module-level string constant used as the load name (the p300 rehearsal rack)', () => {
		const src = [
			"REHEARSAL_PIPETTE = 'p300_single_gen2'",
			"REHEARSAL_TIPRACK = 'cosmas_and_damian_biotix_96_200ul_tiprack'",
			'',
			'def run(protocol):',
			"    tuberack = protocol.load_labware('cosmas_and_damian_drybath_tuberack', 10)",
			'    tiprack = protocol.load_labware(REHEARSAL_TIPRACK, 11)',
			'    pipette = protocol.load_instrument(REHEARSAL_PIPETTE, mount=mount, tip_racks=[tiprack])'
		].join('\n');
		expect(labwareNamesReferencedBy(src).sort()).toEqual(['cosmas_and_damian_biotix_96_200ul_tiprack', 'cosmas_and_damian_drybath_tuberack']);
	});

	it('does not invent a name for an identifier with no constant behind it', () => {
		const src = ['def run(protocol):', '    rack = protocol.load_labware(rack_name, 11)'].join('\n');
		expect(labwareNamesReferencedBy(src)).toEqual([]);
	});
});
