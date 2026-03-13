/**
 * Client-side test data for autofill buttons.
 * Provides realistic, functional test values for the assay/cartridge workflow.
 */

interface Instruction {
	type: string;
	params?: number[];
	code?: Instruction[];
}

export const TEST_ASSAY = {
	name: 'Troponin I Rapid Test',
	description:
		'Quantitative cardiac troponin I immunoassay for point-of-care diagnosis. ' +
		'Uses gold nanoparticle-labeled anti-cTnI antibodies with optical detection. ' +
		'Linear range: 0.02-25 ng/mL. Sample volume: 10 uL whole blood. ' +
		'Total assay time: ~8 minutes.',
	instructions: [
		{ type: 'START_TEST' },
		{ type: 'MOVE_MICRONS', params: [13350, 350] },
		{ type: 'DELAY', params: [5000] },
		{ type: 'SET_SENSOR_PARAMS', params: [2, 1, 150] },
		{ type: 'BASELINE_SCANS', params: [5] },
		{ type: 'DELAY', params: [3000] },
		{
			type: 'REPEAT_BEGIN',
			params: [44],
			code: [
				{ type: 'MOVE_MICRONS', params: [100, 350] },
				{ type: 'DELAY', params: [2000] },
				{ type: 'TEST_SCANS', params: [3] }
			]
		},
		{ type: 'DELAY', params: [1000] },
		{ type: 'CONTINUOUS_SCANS', params: [10, 500] },
		{ type: 'END_TEST' }
	] satisfies Instruction[]
};

export function getTestCartridgeData(): Record<string, string> {
	const now = new Date();
	const expiry = new Date(now.getTime() + 180 * 24 * 60 * 60 * 1000);
	const seq = String(now.getTime()).slice(-4);

	return {
		barcode: '',
		lotNumber: `LOT-2026-${seq}`,
		cartridgeType: 'measurement',
		serialNumber: `SN-TEST-${seq}`,
		manufacturer: 'Bioscale Inc.',
		expirationDate: expiry.toISOString().split('T')[0],
		totalUses: '100',
		storageLocation: 'Lab Refrigerator R-2, Shelf 3',
		storageConditions: '2-8\u00B0C',
		notes: 'Autofill test cartridge for workflow validation'
	};
}
