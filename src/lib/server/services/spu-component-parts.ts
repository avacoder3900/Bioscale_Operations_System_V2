/**
 * SPU component -> parts map, curated from WIMF-SPU-01 "SPU Manufacturing Work
 * Instruction" VERSION 18 (2026-07-30). This is the reassembly-inventory
 * knowledge base: it answers "which parts (and how many) live in the heating
 * block / upper metal bracket / enclosure ..." independent of the step-by-step
 * text, so agent flows can resolve operator language like "all magnets in the
 * heating block" to concrete part numbers.
 *
 * Quantities are per one SPU. Aliases are the words operators actually use.
 * Keep this in sync with the active work instruction when it revs — parts NOT
 * yet in the inventory system (e.g. PT-SPU-104) are still listed here so usage
 * can be tracked in conversation; the reassembly endpoint will reject them
 * until they are added to part_definitions.
 */

export interface ComponentPart {
	partNumber: string;
	name: string;
	quantityPerUnit: number;
	note?: string;
	/**
	 * Set when the part is genuinely part of the build but must NOT be deducted
	 * by kit withdrawal — e.g. it is not stocked, or its per-unit quantity is
	 * still unresolved. The part stays in this map because the map is also the
	 * reassembly knowledge base ("what lives in the antennas component?"); only
	 * the withdrawal skips it, and this string is shown to the operator as the
	 * reason so the gap stays visible.
	 */
	kitExclusion?: string;
}

export interface SpuComponent {
	key: string;
	name: string;
	aliases: string[];
	parts: ComponentPart[];
}

export const SPU_COMPONENT_PARTS: SpuComponent[] = [
	{
		key: 'base_structure',
		name: 'Base Structure (Structure Bottom)',
		aliases: ['structure bottom', 'base', 'bottom structure', 'spacers', 'dowel pins', 'sleeve bearings'],
		parts: [
			{ partNumber: 'PT-SPU-044', name: 'Structure Bottom', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-051', name: 'Undersized Dowel Pin 18-8 SS, 5mm x 20mm', quantityPerUnit: 2 },
			{ partNumber: 'PT-SPU-052', name: 'Off-White Nylon Unthreaded Spacer', quantityPerUnit: 2 },
			{ partNumber: 'PT-SPU-041', name: 'Oil-Embedded Sleeve Bearing', quantityPerUnit: 2 }
		]
	},
	{
		key: 'drive',
		name: 'Drive (Stepper Motor + Pulley)',
		aliases: ['stepper motor', 'motor', 'pulley', '40 tooth pulley', 'gt-2 pulley'],
		parts: [
			{
				partNumber: 'PT-SPU-016',
				name: 'Stepper Motor',
				quantityPerUnit: 1,
				note: 'Mounting screws are included with the motor — no separate screw part.'
			},
			{
				partNumber: 'PT-SPU-105',
				name: '40 T 5mm bore pulley',
				quantityPerUnit: 1,
				note: 'The 40-tooth 5 mm bore pulley, which supersedes the 20-tooth PT-SPU-017. NOTE: WIMF-SPU-01 v18 calls this part PT-SPU-104, but in part_definitions PT-SPU-104 is "Nickel plated Neodymium magnets" and the pulley is PT-SPU-105 — the number was reassigned after the WI was written. This map follows part_definitions, because that is what deductions resolve against. The WI text still needs correcting.'
			}
		]
	},
	{
		key: 'linear_rail',
		name: 'Linear Rail Assembly (LRA)',
		aliases: ['lra', 'rail', 'linear rail'],
		parts: [
			{ partNumber: 'PT-SPU-028', name: 'Linear Rail Assembly', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-030', name: 'M3.12 x 12 mm - Torx Plastic Thread-Forming', quantityPerUnit: 3, note: 'Attaches LRA to Structure Bottom.' }
		]
	},
	{
		key: 'heater_block',
		name: 'Heater Block (heating block + magnet chain)',
		aliases: ['heating block', 'heater block', 'magnet chain', 'magnets in heating block', 'magnet stacks'],
		parts: [
			{ partNumber: 'PT-SPU-013', name: 'Heater Block', quantityPerUnit: 1 },
			{
				partNumber: 'PT-SPU-104',
				name: 'Nickel plated Neodymium magnets',
				quantityPerUnit: 3,
				note: 'The nickel-plated spherical magnet, which supersedes PT-SPU-008 (Main Magnet - Spherical); PT-SPU-008 no longer exists in part_definitions. "All magnets in heating block" = 3x PT-SPU-104 + 6x PT-SPU-009 (three magnet wells/stacks). Per-well composition varies (1 spherical + 1-2 cylindrical) — if only some wells changed, ask the operator exactly how many of each magnet.'
			},
			{ partNumber: 'PT-SPU-009', name: 'Support Magnet - Cylindrical', quantityPerUnit: 6 },
			{ partNumber: 'PT-SPU-005', name: 'M3 x 25 mm - low profile SHCS', quantityPerUnit: 4, note: 'Mounts the Heater Block onto the LRA.' }
		]
	},
	{
		key: 'timing_belt_stage',
		name: 'Timing Belt + Stage Brackets',
		aliases: ['timing belt', 'belt', 'stage brackets', 'distal bracket', 'proximal bracket'],
		parts: [
			{
				partNumber: 'PT-SPU-032',
				name: 'Timing Belt 351 mm (cut from 6mm x 3000mm)',
				quantityPerUnit: 351,
				note: 'One 351 mm cut per SPU (was 350 mm). Quantity is in MILLIMETRES, not cuts — matches quantityPerUnit on the part definition. Stock is currently counted in 3000 mm spools (inventoryCount 7), so mm deductions will drive it negative until the unit of measure on PT-SPU-032 is reconciled.'
			},
			{ partNumber: 'PT-SPU-015', name: 'Distal Stage Bracket', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-014', name: 'Proximal Stage Bracket', quantityPerUnit: 1 }
		]
	},
	{
		key: 'stage_board',
		name: 'Stage Board + Cartridge Heater',
		aliases: ['stage board', 'cartridge heater', 'thermistor'],
		parts: [
			{ partNumber: 'SBA-SPU-004', name: 'Stage Board', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-002', name: 'M3 x 40 mm SHCS', quantityPerUnit: 2 },
			{ partNumber: 'PT-SPU-031', name: 'Cartridge Heater', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-003', name: 'M3 Self-Retaining Washer - Nylon', quantityPerUnit: 1, note: 'Stage Board to Proximal Stage Bracket.' },
			{ partNumber: 'PT-SPU-004', name: 'M3.12 x 8 mm - Torx Plastic Thread-Forming', quantityPerUnit: 1, note: 'Stage Board to Proximal Stage Bracket.' },
			{ partNumber: 'PT-SPU-006', name: 'M3 split lock washer', quantityPerUnit: 2 },
			{ partNumber: 'PT-SPU-007', name: 'M3 High Hex Nut', quantityPerUnit: 2 }
		]
	},
	{
		key: 'structure_top',
		name: 'Structure Top',
		aliases: ['structure top', 'top structure'],
		parts: [
			{ partNumber: 'PT-SPU-027', name: 'Structure Top', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-030', name: 'M3.12 x 12 mm - Torx Plastic Thread-Forming', quantityPerUnit: 4, note: 'Attaches Structure Top to Structure Bottom.' }
		]
	},
	{
		key: 'upper_magnet_bracket',
		name: 'Upper Magnet Bracket (upper metal bracket)',
		aliases: ['upper magnet bracket', 'upper metal bracket', 'upper bracket', 'holding magnet', 'magnet bar'],
		parts: [
			{ partNumber: 'PT-SPU-012', name: 'Upper Magnet Bracket', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-029', name: 'M3 x 10 mm SHCS', quantityPerUnit: 2, note: 'The screws that attach the Upper Magnet Bracket to the Heater Block.' },
			{ partNumber: 'PT-SPU-009', name: 'Support Magnet - Cylindrical', quantityPerUnit: 3, note: 'Attached to the Holding Magnet Bar.' },
			{ partNumber: 'PT-SPU-010', name: 'Holding Magnet - Bar', quantityPerUnit: 1 },
			{
				partNumber: 'PT-SPU-099',
				name: 'Aluminum Tape',
				quantityPerUnit: 1,
				note: 'Cut and attached over the Upper Magnet Bracket. Consumed as a length in mm, but the per-SPU length is not yet established. (part_definitions carries quantityPerUnit 60, which has not been confirmed as the real figure.)',
				kitExclusion: 'Consumed by length in mm — the per-SPU length has not been set yet, so nothing is deducted.'
			}
		]
	},
	{
		key: 'scanner_main_board',
		name: 'Barcode Scanner + Main Board',
		aliases: ['barcode scanner', 'scanner', 'main board', 'motion board'],
		parts: [
			{ partNumber: 'PT-SPU-018', name: 'Barcode Scanner', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-033', name: 'Torx T5 - M1.6x3 (Screws - Barcode Scanner)', quantityPerUnit: 2 },
			{ partNumber: 'SBA-SPU-003', name: 'Main Board', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-003', name: 'M3 Self-Retaining Washer - Nylon', quantityPerUnit: 3, note: 'Main Board to Structure Top.' },
			{ partNumber: 'PT-SPU-004', name: 'M3.12 x 8 mm - Torx Plastic Thread-Forming', quantityPerUnit: 3, note: 'Main Board to Structure Top.' }
		]
	},
	{
		key: 'antennas',
		name: 'Antennas',
		aliases: ['antenna', 'gnss', 'cellular antenna', 'wifi antenna', 'ble antenna'],
		parts: [
			{
				partNumber: 'PT-SPU-101',
				name: 'GNSS Antenna',
				quantityPerUnit: 1,
				kitExclusion: 'Not withdrawn by the kit; no part definition exists for it in inventory.'
			},
			{
				partNumber: 'PT-SPU-102',
				name: 'Wide Band Cellular Antenna',
				quantityPerUnit: 1,
				kitExclusion: 'Not withdrawn by the kit; no part definition exists for it in inventory.'
			},
			{
				partNumber: 'PT-SPU-103',
				name: 'Wi-Fi/BLE Antenna',
				quantityPerUnit: 1,
				kitExclusion: 'Not withdrawn by the kit; no part definition exists for it in inventory.'
			}
		]
	},
	{
		key: 'enclosure',
		name: 'Enclosure (sheet metal + front/back + mirror)',
		aliases: ['enclosure', 'sheet metal', 'enclosure front', 'enclosure back', 'bumpers', 'mirror', 'lens cap'],
		parts: [
			{ partNumber: 'PT-SPU-021', name: 'Black Sheet Metal Enclosure', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-024', name: 'Heavy Duty Unthreaded Bumpers', quantityPerUnit: 4 },
			{ partNumber: 'PT-SPU-030', name: 'M3.12 x 12 mm - Torx Plastic Thread-Forming', quantityPerUnit: 4, note: 'Attaches bumpers to the enclosure base.' },
			{ partNumber: 'PT-SPU-019', name: '#4 x 1/4 Flat Head Thread-Forming Screw', quantityPerUnit: 4, note: '2 for the Enclosure Back + 2 for the Enclosure Front.' },
			{ partNumber: 'PT-SPU-020', name: 'LED Lens Cap', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-022', name: 'Enclosure Front', quantityPerUnit: 1 },
			{ partNumber: 'PT-SPU-036', name: 'Acrylic Mirror - 23mm x 27mm', quantityPerUnit: 1 }
		]
	},
	{
		key: 'labels',
		name: 'Labels',
		aliases: ['label', 'udi label', 'top label', 'side label', 'front label', 'dc input label'],
		parts: [
			{ partNumber: 'PT-SPU-072', name: 'Avery Label Template 5523', quantityPerUnit: 1, note: 'Not in the inventory system yet.' },
			{ partNumber: 'PT-SPU-070', name: 'DC Input Label', quantityPerUnit: 1, note: 'Not in the inventory system yet.' },
			{ partNumber: 'PT-SPU-056', name: 'Top Label', quantityPerUnit: 1, note: 'Not in the inventory system yet.' },
			{ partNumber: 'PT-SPU-057', name: 'Side Label', quantityPerUnit: 1, note: 'Not in the inventory system yet.' },
			{ partNumber: 'PT-SPU-058', name: 'UDI Label', quantityPerUnit: 1, note: 'Not in the inventory system yet.' },
			{ partNumber: 'PT-SPU-059', name: 'Front Label', quantityPerUnit: 1, note: 'Not in the inventory system yet.' }
		]
	}
];
