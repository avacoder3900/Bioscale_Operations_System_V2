/**
 * One-shot: seed first-pass ReagentProtocolTemplate documents for the 5 R&D /
 * cartridge-prep spreadsheets shared by the user 2026-05-14:
 *   - SuperQD Phase 1 (TEOS Shell)
 *   - SuperQD Phase 2 (Silane-PEG-NHS + Protein conjugation)
 *   - Antibody Biotinylation (LP2)
 *   - HEPES Cortisol Buffer
 *   - Cortisol Bead Mix
 *   - Cortisol Tracer
 *
 * Idempotent — upserts on (slug, version). Re-run to refresh.
 *
 * FIRST-PASS NOTES (hand-curate as protocols mature):
 *   - Step `reagents[]` formulas are strings. Most are placeholder text mirrors
 *     of the Excel formulas (e.g. "(finalVolume * desiredConc) / stockConc").
 *     The runner UI will evaluate them in a future pass; for now they document
 *     the math.
 *   - QC checkpoints are extracted where the spreadsheets called them out
 *     explicitly (Checkpoint 1/2/3 in SuperQD; HABA + Nano Orange in Antibody
 *     Biotinylation). Implicit "Process Standards" targets (Step 1 Target 2
 *     mg/mL etc.) are seeded as quantitative checkpoints on the relevant step.
 *   - Observation prompts are stubbed from real lot notes observed in the
 *     spreadsheets (e.g. "AT lot had colored supernatant" → "Supernatant
 *     color after Phase 1 wash").
 *
 * Run: npx tsx scripts/seed-reagent-protocols.ts
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

type Param = { key: string; label: string; unit?: string; type?: 'number' | 'text' | 'select'; defaultValue?: any; helpText?: string };
type Ratio = { key: string; label: string; parameter1Key: string; parameter1Value: number; parameter2Key: string; parameter2Value: number; notes?: string };
type Material = { key: string; label: string; type: 'stock' | 'prepared' | 'reused'; defaultConcentration?: number; defaultConcentrationUnit?: string; molecularWeight?: number; stockAmount?: number; stockUnit?: string; costPerStockUnit?: number; canSourceFromSlugs?: string[]; notes?: string };
type Checkpoint = { key: string; label: string; type: 'quantitative' | 'qualitative' | 'observation'; unit?: string; expectedMin?: number; expectedMax?: number; expectedValue?: string; helpText?: string };
type Step = { key: string; number: number; title: string; instructions: string; reagents?: Array<{ materialKey: string; label: string; formula: string; unit: string; notes?: string }>; timing?: { durationMinutes?: number; intervalMinutes?: number; temperatureC?: number; rpm?: number; notes?: string }; qcCheckpoints?: Checkpoint[]; observationPrompts?: Array<{ key: string; label: string; helpText?: string }> };

type Template = {
	slug: string;
	name: string;
	version: number;
	status: 'draft' | 'active' | 'retired';
	category: 'rnd' | 'cartridge-prep' | 'other';
	description: string;
	sourceSpreadsheet: string;
	parameters: Param[];
	ratios: Ratio[];
	materials: Material[];
	steps: Step[];
	postProtocolAssays?: Array<{ key: string; label: string; instructions: string; readings: Checkpoint[] }>;
	outputSpec: { productName: string; expectedConcentration?: number; concentrationUnit?: string; expectedVolume?: number; volumeUnit?: string };
};

const templates: Template[] = [
	// ─────────────────────────────────────────────────────────────────────────
	// SuperQD - Phase 1 (TEOS Shell)
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'superqd-phase-1',
		name: 'SuperQD - Phase 1 (TEOS Shell)',
		version: 1,
		status: 'active',
		category: 'rnd',
		sourceSpreadsheet: 'SuperQD - Phase1 TEOS Updated April 21, 2026 (1).xlsx',
		description: 'Activate carboxyl quantum dots with EDC/NHS, couple to 50 nm silica particles, then Stöber-coat with TEOS overnight to produce SuperQDs at ~20 nM.',
		parameters: [
			{ key: 'silicaParticleMass', label: 'Silica Particle Mass', unit: 'mg', type: 'number', defaultValue: 2 },
			{ key: 'carboxylQdWavelength', label: 'Carboxyl QD Wavelength', unit: 'nm', type: 'select', defaultValue: 480, helpText: '480 (chicken) or 630 (cortisol)' },
			{ key: 'desiredFinalConc', label: 'Desired Final SuperQD Concentration', unit: 'nM', type: 'number', defaultValue: 20 },
			{ key: 'targetShellThickness', label: 'Target Shell Thickness', unit: 'nm', type: 'number', defaultValue: 15 },
			{ key: 'checkpoint1Conc', label: 'Checkpoint 1 Solution Concentration', unit: 'nM', type: 'number', defaultValue: 1 },
			{ key: 'checkpoint1Volume', label: 'Checkpoint 1 Solution Volume', unit: 'uL', type: 'number', defaultValue: 5000 },
			{ key: 'checkpoint2Conc', label: 'Checkpoint 2 Solution Concentration', unit: 'nM', type: 'number', defaultValue: 1 },
			{ key: 'checkpoint2Volume', label: 'Checkpoint 2 Solution Volume', unit: 'uL', type: 'number', defaultValue: 32 }
		],
		ratios: [
			{ key: 'silicaToQd', label: 'Silica Particle : Carboxyl QD', parameter1Key: 'silica', parameter1Value: 1, parameter2Key: 'qd', parameter2Value: 100 },
			{ key: 'qdToEdc', label: 'Carboxyl QD : EDC', parameter1Key: 'qd', parameter1Value: 1, parameter2Key: 'edc', parameter2Value: 1500 },
			{ key: 'qdToNhs', label: 'Carboxyl QD : NHS', parameter1Key: 'qd', parameter1Value: 1, parameter2Key: 'nhs', parameter2Value: 1500 },
			{ key: 'waterToMes', label: 'Water : MES (activation)', parameter1Key: 'water', parameter1Value: 1, parameter2Key: 'mes', parameter2Value: 10 }
		],
		materials: [
			{ key: 'silica', label: 'Silica Particles 50nm in Ethanol', type: 'stock', defaultConcentration: 10, defaultConcentrationUnit: 'mg/mL', stockAmount: 25000, stockUnit: 'uL', costPerStockUnit: 210 },
			{ key: 'carboxylQd', label: 'Carboxyl QD', type: 'stock', defaultConcentration: 4.17, defaultConcentrationUnit: 'uM', stockAmount: 5000, stockUnit: 'uL', costPerStockUnit: 1719.9, notes: 'Stock conc varies by wavelength: 480=4.17 uM, 630=3.12 uM' },
			{ key: 'edc', label: 'EDC', type: 'stock', molecularWeight: 155.245, stockAmount: 10000, stockUnit: 'mg', costPerStockUnit: 356 },
			{ key: 'nhs', label: 'NHS', type: 'stock', molecularWeight: 217, stockAmount: 5000, stockUnit: 'mg', costPerStockUnit: 1160 },
			{ key: 'aptms', label: 'APTMS 97%', type: 'stock', defaultConcentration: 97, defaultConcentrationUnit: '%', stockAmount: 5000, stockUnit: 'uL', costPerStockUnit: 62.3 },
			{ key: 'teos', label: 'TEOS 98%', type: 'stock', defaultConcentration: 98, defaultConcentrationUnit: '%', molecularWeight: 208.33, stockAmount: 500000, stockUnit: 'uL', costPerStockUnit: 42.1 },
			{ key: 'ethanol', label: 'Ethanol 99.5%', type: 'stock', defaultConcentration: 99.5, defaultConcentrationUnit: '%', stockAmount: 4000000, stockUnit: 'uL', costPerStockUnit: 567.5 },
			{ key: 'ipa', label: 'IPA 99%', type: 'stock', defaultConcentration: 99, defaultConcentrationUnit: '%', stockAmount: 3780000, stockUnit: 'uL', costPerStockUnit: 68.9 },
			{ key: 'nh4oh', label: 'Ammonium Hydroxide 28-30%', type: 'stock', defaultConcentration: 28, defaultConcentrationUnit: '%', stockAmount: 100000, stockUnit: 'uL', costPerStockUnit: 38.6 },
			{ key: 'water', label: 'Distilled Water', type: 'stock', stockAmount: 500000, stockUnit: 'uL', costPerStockUnit: 26.8 },
			{ key: 'mes', label: 'MES Buffer pH 6', type: 'reused', stockAmount: 500000, stockUnit: 'uL', costPerStockUnit: 21.15 },
			{ key: 'pbs', label: 'PBS Buffer pH 7', type: 'stock', stockAmount: 1000000, stockUnit: 'uL', costPerStockUnit: 40.667 }
		],
		steps: [
			{ key: 'wash-silica', number: 1, title: 'Wash Silica Particles', instructions: 'Sonicate the stock 50nm silica particles for 5 minutes. Pipette the calculated amount into a clean glass centrifuge tube. Centrifuge at 2.8g for 1 hr. Carefully pellet, remove supernatant (leaving ~5%), and resuspend in PBS. Sonicate 2 minutes.', reagents: [{ materialKey: 'silica', label: 'Silica Stock', formula: 'silicaParticleMass / silicaStockConc * 1000', unit: 'uL' }, { materialKey: 'pbs', label: 'PBS', formula: '100', unit: 'uL' }], timing: { durationMinutes: 60, notes: 'Centrifuge 2.8g × 1 hr, then sonicate 2 min' }, qcCheckpoints: [{ key: 'wash-target-conc', label: 'Step 1 Target Concentration', type: 'quantitative', unit: 'mg/mL', expectedValue: '2', helpText: 'Implicit process-standards target — measure or estimate' }] },
			{ key: 'measure-qd-fluorescence', number: 2, title: 'Measure Carboxyl QD Fluorescence (Checkpoint 1)', instructions: 'Prepare a diluted QD solution at Checkpoint 1 Concentration in PBS. Set up the Tecan spectrometer (25°C, gain 70, one scan per sample). Pipette 28 uL into the plate. Take a fluorescence intensity measurement AND a fluorescence scan. Do NOT add this sample back into the stock QD solution.', reagents: [{ materialKey: 'carboxylQd', label: 'Carboxyl QD Stock', formula: '(checkpoint1Conc * 1e-3 * checkpoint1Volume) / qdStockConc', unit: 'uL' }, { materialKey: 'pbs', label: 'PBS', formula: 'checkpoint1Volume - qdVolume', unit: 'uL' }], qcCheckpoints: [{ key: 'qd-fluorescence-intensity', label: 'Carboxyl QD Fluorescence Intensity', type: 'quantitative', unit: 'AU', helpText: 'Tecan reading at appropriate emission wavelength' }, { key: 'qd-fluorescence-scan', label: 'Carboxyl QD Fluorescence Scan', type: 'quantitative', unit: 'AU', helpText: 'Tecan scan reading' }] },
			{ key: 'dilute-qd-mes', number: 3, title: 'Dilute QDs in MES', instructions: 'Dilute the stock Carboxyl QD into MES buffer pH 6 to reach the Step 2 Target activation concentration.', reagents: [{ materialKey: 'carboxylQd', label: 'Carboxyl QD Stock', formula: 'molesQd / qdStockConc * 1e6', unit: 'uL' }, { materialKey: 'mes', label: 'MES Buffer pH 6', formula: '(qdVolume * qdStockConc / step2TargetConc) - qdVolume', unit: 'uL' }], qcCheckpoints: [{ key: 'activation-target-conc', label: 'Step 2 Target Concentration', type: 'quantitative', unit: 'uM', expectedValue: '2' }] },
			{ key: 'prep-edc', number: 4, title: 'Prepare EDC Solution', instructions: 'Weigh out EDC powder and dissolve in MES buffer pH 6 to a 10 mg/mL working solution.', reagents: [{ materialKey: 'edc', label: 'EDC powder', formula: 'edcMass', unit: 'mg' }, { materialKey: 'mes', label: 'MES Buffer pH 6', formula: 'edcMass / 10 * 1000', unit: 'uL' }] },
			{ key: 'prep-nhs', number: 5, title: 'Prepare NHS Solution', instructions: 'Weigh out NHS powder and dissolve in MES buffer pH 6 to a 10 mg/mL working solution.', reagents: [{ materialKey: 'nhs', label: 'NHS powder', formula: 'nhsMass', unit: 'mg' }, { materialKey: 'mes', label: 'MES Buffer pH 6', formula: 'nhsMass / 10 * 1000', unit: 'uL' }] },
			{ key: 'activate-qd', number: 6, title: 'Activate QDs with EDC and NHS', instructions: 'Add EDC and NHS solutions to the Carboxyl QD MES solution. React 20 minutes at room temperature. Every 5 minutes inspect the QD solution; if not well mixed, gently vortex or sonicate for a few seconds.', reagents: [{ materialKey: 'edc', label: 'EDC Solution', formula: 'edcMass / 10 * 1000', unit: 'uL' }, { materialKey: 'nhs', label: 'NHS Solution', formula: 'nhsMass / 10 * 1000', unit: 'uL' }], timing: { durationMinutes: 20, intervalMinutes: 5, temperatureC: 25 }, observationPrompts: [{ key: 'activation-mixing', label: 'Was the QD solution well-mixed throughout?', helpText: 'Note any pelleting, color change, or need for re-sonication' }] },
			{ key: 'filter-qd', number: 7, title: 'Filter Activated QDs', instructions: 'Filter the activated QDs through a 10 kDa concentrator (max 600 uL per spin). Centrifuge at 5g for 10 min (retained volume should be 20-50 uL — if not, spin an additional 5 min). Add 450 uL MES, pipette to mix, spin again. Repeat once more.', timing: { durationMinutes: 30, notes: '2-3 rounds, 10 min each at 5g' } },
			{ key: 'mix-qd-silica', number: 8, title: 'Mix Activated QDs and Silica Particles', instructions: 'Resuspend the retained activated QDs in 180 uL PBS, scrape off filter face, transfer to a new tube with stirring rod on a magnetic plate at 820 rpm. Add silica particles dropwise. React 1 hour at room temperature. Every 20 minutes inspect mixing. Spin down for 25 min at 12.4g and resuspend in 350 uL ethanol. Sonicate.', timing: { durationMinutes: 60, intervalMinutes: 20, rpm: 820 }, observationPrompts: [{ key: 'qd-silica-mixing', label: 'Were the particles well-mixed during the 1-hour reaction?' }] },
			{ key: 'prep-aptms-int1', number: 9, title: 'Prepare APTMS Intermediate 1', instructions: 'Dilute 97% APTMS stock to 0.1% in ethanol.' },
			{ key: 'prep-aptms-int2', number: 10, title: 'Prepare APTMS Intermediate 2', instructions: 'Dilute APTMS Intermediate 1 to 0.0001% in ethanol.' },
			{ key: 'prep-teos-int', number: 11, title: 'Prepare TEOS Intermediate', instructions: 'Dilute 98% TEOS stock to 0.1% in IPA.' },
			{ key: 'add-aptms', number: 12, title: 'Add APTMS to SuperQDs', instructions: 'Add APTMS Intermediate 2 solution and additional ethanol to the SuperQD solution. React 10 minutes at room temperature on the rotary. Every 2 minutes gently vortex or sonicate.', timing: { durationMinutes: 10, intervalMinutes: 2, temperatureC: 25 } },
			{ key: 'wash-superqd-stober', number: 13, title: 'Wash SuperQDs into Stöber Solvent', instructions: 'Transfer to a low-bind microtube. Centrifuge 12.4g for 15 min. Create the IPA / Water / NH4OH Stöber solvent mixture (72.98% / 25.26% / 1.75%) while spinning. Pellet, remove supernatant, resuspend in the Stöber mixture. Sonicate 5 min. Transfer to a stirring rod tube at 820 rpm.', timing: { durationMinutes: 15, rpm: 820 } },
			{ key: 'add-teos', number: 14, title: 'Add TEOS (6 aliquots over 1 hour)', instructions: 'Add the TEOS intermediate dropwise across 6 equal aliquots, one every 10 minutes over 1 hour total. Keep magnetic stirrer at 820 rpm. After the final addition, react overnight at room temperature, covered to avoid light exposure.', timing: { durationMinutes: 60, intervalMinutes: 10, rpm: 820, notes: 'Then overnight react' } },
			{ key: 'wash-final', number: 15, title: 'Final Wash of SuperQDs', instructions: 'Centrifuge 12.4g × 15 min. Carefully remove supernatant. Resuspend in 1000 uL 95% ethanol / 5% DI water. Pipette slowly, sonicate 30 seconds. Repeat once. Second resuspension at the final SuperQD volume.', timing: { durationMinutes: 15 } },
			{ key: 'measure-superqd-fluorescence', number: 16, title: 'Measure SuperQD Fluorescence (Checkpoint 2)', instructions: 'Prepare a diluted SuperQD solution at Checkpoint 2 Concentration in PBS. Run the same Tecan template as Checkpoint 1. Also measure the supernatant from the final wash. Add the sample back to the stock SuperQD solution when done.', qcCheckpoints: [{ key: 'superqd-fluorescence-intensity', label: 'SuperQD Fluorescence Intensity', type: 'quantitative', unit: 'AU' }, { key: 'superqd-fluorescence-scan', label: 'SuperQD Fluorescence Scan', type: 'quantitative', unit: 'AU' }, { key: 'supernatant-fluorescence-intensity', label: 'Supernatant Fluorescence Intensity', type: 'quantitative', unit: 'AU', helpText: 'High supernatant fluorescence may indicate QD leakage' }, { key: 'supernatant-fluorescence-scan', label: 'Supernatant Fluorescence Scan', type: 'quantitative', unit: 'AU' }], observationPrompts: [{ key: 'supernatant-color', label: 'Color of supernatant after Phase 1 wash', helpText: 'Per real lot observation: AT lot had colored supernatant, JQ lot had clear — note differences here' }] }
		],
		outputSpec: { productName: 'SuperQD - Phase 1', expectedConcentration: 20, concentrationUnit: 'nM', volumeUnit: 'uL' }
	},

	// ─────────────────────────────────────────────────────────────────────────
	// SuperQD - Phase 2 (Silane-PEG-NHS + Protein conjugation)
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'superqd-phase-2',
		name: 'SuperQD - Phase 2 (Protein Conjugation)',
		version: 1,
		status: 'active',
		category: 'rnd',
		sourceSpreadsheet: 'Super QD - Phase 2 TEOS Updated April 21, 2026 (1).xlsx',
		description: 'Coat SuperQD particles from Phase 1 with Silane-PEG-NHS, then conjugate to a protein/antibody. Quench with TRIS, wash into storage buffer.',
		parameters: [
			{ key: 'superqdMass', label: 'SuperQD Particles to Conjugate', unit: 'mg', type: 'number', defaultValue: 2 },
			{ key: 'superqdVolumeIn', label: 'SuperQD Volume to Conjugate', unit: 'uL', type: 'number', defaultValue: 1268.59 },
			{ key: 'superqdConcIn', label: 'SuperQD Input Concentration', unit: 'nM', type: 'number', defaultValue: 20 },
			{ key: 'desiredFinalConc', label: 'Desired Final SuperQD-Protein Concentration', unit: 'nM', type: 'number', defaultValue: 10 },
			{ key: 'checkpoint3Conc', label: 'Checkpoint 3 Solution Concentration', unit: 'nM', type: 'number', defaultValue: 1 },
			{ key: 'checkpoint3Volume', label: 'Checkpoint 3 Solution Volume', unit: 'uL', type: 'number', defaultValue: 30 }
		],
		ratios: [
			{ key: 'superqdToQd', label: 'SuperQD : Carboxyl QD', parameter1Key: 'superqd', parameter1Value: 1, parameter2Key: 'qd', parameter2Value: 100 },
			{ key: 'qdToSilanePeg', label: 'Carboxyl QD : Silane-PEG-NHS', parameter1Key: 'qd', parameter1Value: 1, parameter2Key: 'silanePegNhs', parameter2Value: 200 },
			{ key: 'qdToProtein', label: 'Carboxyl QD : Protein/Ab', parameter1Key: 'qd', parameter1Value: 1, parameter2Key: 'protein', parameter2Value: 2, notes: 'Varies by antibody: 2 for chicken, 1 for cortisol' }
		],
		materials: [
			{ key: 'superqd', label: 'SuperQD (from Phase 1)', type: 'prepared', canSourceFromSlugs: ['superqd-phase-1'], notes: 'Input lot — select a finalized SuperQD Phase 1 lot' },
			{ key: 'silanePegNhs', label: 'Silane-PEG-NHS', type: 'stock', molecularWeight: 2000, stockAmount: 100, stockUnit: 'mg', costPerStockUnit: 385 },
			{ key: 'protein', label: 'Protein / Antibody', type: 'prepared', molecularWeight: 150000, canSourceFromSlugs: ['antibody-biotinylation'], notes: 'Input lot — typically a biotinylated antibody. Leave dropdown blank if entering a raw protein by barcode.' },
			{ key: 'tris', label: 'TRIS Buffer', type: 'stock', stockAmount: 2000000, stockUnit: 'uL', costPerStockUnit: 117 },
			{ key: 'pbs', label: 'PBS Buffer pH 7', type: 'stock', stockAmount: 1000000, stockUnit: 'uL', costPerStockUnit: 40.667 },
			{ key: 'ethanol', label: '95% Ethanol 5% DI Water', type: 'stock', defaultConcentration: 95, defaultConcentrationUnit: '%', stockAmount: 4000000, stockUnit: 'uL', costPerStockUnit: 567.5 },
			{ key: 'storageBuffer', label: 'Storage Buffer (HEPES Cortisol Buffer no ions)', type: 'prepared', canSourceFromSlugs: ['hepes-cortisol-buffer'], stockAmount: 2000000, stockUnit: 'uL', costPerStockUnit: 117 }
		],
		steps: [
			{ key: 'prep-silane-peg', number: 1, title: 'Prepare Silane-PEG-NHS Solution', instructions: 'Dissolve 4 mg Silane-PEG-NHS in 95% Ethanol / 5% DI Water to 10 mg/mL. Vortex for 3 minutes. Ensure no pellets or particles before adding to the SuperQDs.', reagents: [{ materialKey: 'silanePegNhs', label: 'Silane-PEG-NHS', formula: '4', unit: 'mg' }, { materialKey: 'ethanol', label: '95% Ethanol 5% DI Water', formula: 'silanePegNhsMass / 10 * 1000', unit: 'uL' }], timing: { durationMinutes: 3 } },
			{ key: 'add-silane-peg', number: 2, title: 'Add Silane-PEG-NHS to SuperQDs', instructions: 'Sonicate the SuperQDs for 2 minutes before adding Silane-PEG-NHS Solution. Add according to ratio. React 1 hour 30 minutes at room temperature on the rotary. Every 20 minutes gently vortex or sonicate.', timing: { durationMinutes: 90, intervalMinutes: 20, temperatureC: 25 }, observationPrompts: [{ key: 'rxn-mixing-1', label: 'Was the SuperQD solution well-mixed during the silane reaction?' }] },
			{ key: 'wash-superqd-1', number: 3, title: 'Wash SuperQD Particles (2×)', instructions: 'Centrifuge at 12.4g for 15 min in a glass centrifuge tube. Pellet, remove supernatant, resuspend in 500 uL PBS. Sonicate. Repeat once. Final resuspension: 500 × superqdMass / 0.5 uL minus protein volume. Sonicate 2 min before adding protein.', timing: { durationMinutes: 15 } },
			{ key: 'add-protein', number: 4, title: 'Add Protein / Antibody', instructions: 'Add the protein to be conjugated to the SuperQDs. React 2 hours at room temperature on the rotary. Every 20 minutes inspect mixing. Do not invert or high-vortex.', timing: { durationMinutes: 120, intervalMinutes: 20, temperatureC: 25 }, observationPrompts: [{ key: 'protein-rxn-mixing', label: 'Was the SuperQD-Protein solution well-mixed during the 2-hour reaction?' }] },
			{ key: 'quench-tris', number: 5, title: 'Quench Reaction with TRIS', instructions: 'Add TRIS Buffer at 2× the SuperQD-Protein volume. Vortex 30 seconds. React 5 minutes at room temperature.', reagents: [{ materialKey: 'tris', label: 'TRIS Buffer', formula: 'superqdProteinVolume * 2', unit: 'uL' }], timing: { durationMinutes: 5 } },
			{ key: 'wash-superqd-2', number: 6, title: 'Wash SuperQD-Protein Particles (2×)', instructions: 'Centrifuge at 12.4g for 15 min. Pellet, remove supernatant, resuspend in 500 uL PBS. Sonicate. Repeat once. Final resuspension in Storage Buffer (HEPES Cortisol Buffer no ions).', timing: { durationMinutes: 15 } },
			{ key: 'measure-fluorescence', number: 7, title: 'Measure Fluorescence (Checkpoint 3)', instructions: 'Prepare a diluted SuperQD-Protein solution at Checkpoint 3 Concentration in PBS. Run the Tecan QD scanning template (25°C, gain 70, 28 uL, z-axis calibrated to first sample). Also measure the supernatant from the final wash. Add the sample back to the stock when done.', qcCheckpoints: [{ key: 'superqd-protein-fluorescence-intensity', label: 'SuperQD-Protein Fluorescence Intensity', type: 'quantitative', unit: 'AU' }, { key: 'superqd-protein-fluorescence-scan', label: 'SuperQD-Protein Fluorescence Scan', type: 'quantitative', unit: 'AU' }] }
		],
		outputSpec: { productName: 'SuperQD-Protein', expectedConcentration: 10, concentrationUnit: 'nM', volumeUnit: 'uL' }
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Antibody Biotinylation (LP2)
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'antibody-biotinylation',
		name: 'Antibody Biotinylation (LP2)',
		version: 2,
		status: 'active',
		category: 'rnd',
		sourceSpreadsheet: 'Antibody Biotinylation v2 (2).xlsx',
		description: 'Dilute stock antibody to 2 mg/mL, biotinylate with NHS-PEG4-Biotin at a 12:1 biotin:Ab ratio, quench with Tris, scrub unreacted biotin via concentrator (3×), resuspend at 1.5 mg/mL. Post-protocol: Nano Orange for [protein], HABA for biotin:Ab ratio.',
		parameters: [
			{ key: 'stockAntibodyConc', label: 'Stock Antibody Concentration', unit: 'mg/mL', type: 'number', defaultValue: 4.734, helpText: 'Measure or pull from supplier CofA — varies per supplier lot' },
			{ key: 'desiredVolume', label: 'Desired Volume of Biotinylated Antibody', unit: 'uL', type: 'number', defaultValue: 2900 },
			{ key: 'biotinAbRatio', label: 'Biotin : Antibody Molar Ratio', type: 'number', defaultValue: 12 },
			{ key: 'biotinylationConc', label: 'Antibody Concentration at Biotinylation', unit: 'mg/mL', type: 'number', defaultValue: 2 },
			{ key: 'finalConc', label: 'Final Biotinylated Antibody Concentration', unit: 'mg/mL', type: 'number', defaultValue: 1.5 },
			{ key: 'finalProclinPct', label: 'Final Proclin %', unit: '%', type: 'number', defaultValue: 0.02 }
		],
		ratios: [
			{ key: 'biotinToAb', label: 'Biotin : Antibody', parameter1Key: 'biotin', parameter1Value: 12, parameter2Key: 'antibody', parameter2Value: 1 }
		],
		materials: [
			{ key: 'stockAntibody', label: 'Stock Antibody', type: 'stock', molecularWeight: 150000, stockAmount: 200, stockUnit: 'uL', costPerStockUnit: 400, notes: 'Supplier-specific — record the supplier lot barcode at run start' },
			{ key: 'biotinLinker', label: 'NHS-PEG4-Biotin Linker', type: 'stock', defaultConcentration: 2, defaultConcentrationUnit: 'mg', molecularWeight: 588.67, stockAmount: 10, stockUnit: 'tubes', costPerStockUnit: 293 },
			{ key: 'proclin', label: '5% Proclin', type: 'reused', defaultConcentration: 5, defaultConcentrationUnit: '%', stockAmount: 5000, stockUnit: 'uL', costPerStockUnit: 0.54 },
			{ key: 'tris', label: '1X Tris Buffer', type: 'reused', stockAmount: 2000000, stockUnit: 'uL', costPerStockUnit: 117 },
			{ key: 'pbs', label: 'PBS pH 7', type: 'stock', stockAmount: 1000000, stockUnit: 'uL', costPerStockUnit: 40.67 }
		],
		steps: [
			{ key: 'make-2mg-ml-ab', number: 1, title: 'Make 2 mg/mL Antibody Solution', instructions: 'Pipette PBS and Stock Antibody into a 2 mL lowbind eppendorf tube to make a 2 mg/mL antibody solution at the calculated total volume.', reagents: [{ materialKey: 'stockAntibody', label: 'Stock Antibody', formula: '(totalVolume * biotinylationConc) / stockAntibodyConc', unit: 'uL' }, { materialKey: 'pbs', label: 'PBS', formula: 'totalVolume - stockAntibodyVolume', unit: 'uL' }] },
			{ key: 'reconstitute-biotin', number: 2, title: 'Reconstitute NHS-PEG4-Biotin', instructions: 'Add the calculated PBS volume to the EZ-Link No-Weigh NHS-PEG4-Biotin tube. Mix by steadily pipetting up and down for 2 minutes. Complete the next two steps quickly to keep the biotinylation solution chilled.', timing: { durationMinutes: 2 } },
			{ key: 'biotin-working-solution', number: 3, title: 'NHS-PEG4-Biotin Working Solution', instructions: 'Pipette Reconstituted NHS-PEG-4-Biotin and PBS into a tube according to the calculated volumes (total 2000 uL).' },
			{ key: 'biotinylate', number: 4, title: 'Biotinylate Antibody', instructions: 'Add the NHS-PEG4-Biotin working solution to the 2 mg/mL protein solution tube. Vortex for 10 seconds. Leave at room temperature for 20 minutes, vortexing 10 seconds every 5 minutes at low speed (~1000 rpm). Move immediately to quench at 20 minutes.', timing: { durationMinutes: 20, intervalMinutes: 5, temperatureC: 25, rpm: 1000 }, observationPrompts: [{ key: 'biotinylation-mixing', label: 'Did the solution remain homogeneous through the 20 min reaction?' }] },
			{ key: 'quench-tris', number: 5, title: 'Quench Biotinylation Reaction', instructions: 'Add 1X Tris Buffer to bring the total volume to the desired final volume. The biotinylated antibody can be stored 2-8°C for up to a day to allow time for concentration measurement.', reagents: [{ materialKey: 'tris', label: '1X Tris Buffer', formula: 'desiredVolume - biotinylatedVolume', unit: 'uL' }] },
			{ key: 'concentrator-3x', number: 6, title: 'Remove Unreacted Biotin and Tris (Concentrator 3×)', instructions: 'Distribute the antibody solution into one or more 30k 500 uL concentrators. Top up each to 500 uL with PBS. Spin at 5000 g for 8 minutes. Retained volume should be 15-20 uL. Resuspend with PBS back to 500 uL. Discard the flow-through. Repeat 2 more times.', timing: { durationMinutes: 8, notes: '3 rounds at 5000g × 8 min' }, qcCheckpoints: [{ key: 'retained-volume', label: 'Retained Volume in Concentrator (per round)', type: 'quantitative', unit: 'uL', expectedMin: 15, expectedMax: 20, helpText: 'Flag if outside range — indicates concentrator drift' }] },
			{ key: 'resuspend-1-5', number: 7, title: 'Resuspend to 1.5 mg/mL', instructions: 'Pull the fluid from all concentrators together in a fresh lowbind eppendorf tube. Resuspend with PBS + 5% Proclin to a total volume that brings the concentration to 1.5 mg/mL. Store at 2-8°C while running Nano Orange.', reagents: [{ materialKey: 'pbs', label: 'PBS', formula: 'totalVolume - proclinVolume - biotinylatedVolume', unit: 'uL' }, { materialKey: 'proclin', label: '5% Proclin', formula: 'totalVolume * finalProclinPct / 5', unit: 'uL' }] }
		],
		postProtocolAssays: [
			{ key: 'nano-orange', label: 'Nano Orange (A280-A310) for [Protein]', instructions: 'Set up Tecan with NanoQuantPlate. Measure absorbance at 280 nm and 310 nm. Concentration = (A280 - A310) × 15.75.', readings: [{ key: 'a280', label: 'Absorbance at 280 nm', type: 'quantitative', unit: 'AU' }, { key: 'a310', label: 'Absorbance at 310 nm (background)', type: 'quantitative', unit: 'AU' }, { key: 'measured-protein-conc', label: 'Measured Protein Concentration', type: 'quantitative', unit: 'mg/mL', expectedMin: 1.0, expectedMax: 2.0, helpText: 'Target 1.5 mg/mL — real values seen 0.901 to 1.183' }] },
			{ key: 'haba', label: 'HABA Fluorescence for Biotin:Ab Ratio', instructions: 'Run HABA assay on Corning 384 plate, fluorescence top reading at 485/590 nm, gain 139, 25 flashes. Build standard curve from biocytin dilutions. Subtract zero-biocytin background. Read out biotin per antibody.', readings: [{ key: 'haba-fluorescence', label: 'HABA Fluorescence Reading', type: 'quantitative', unit: 'AU' }, { key: 'biotin-per-ab', label: 'Biotin per Antibody', type: 'quantitative', expectedMin: 10, expectedMax: 14, helpText: 'Target 12:1 ratio' }] }
		],
		outputSpec: { productName: 'Biotinylated Antibody', expectedConcentration: 1.5, concentrationUnit: 'mg/mL', volumeUnit: 'uL' }
	},

	// ─────────────────────────────────────────────────────────────────────────
	// HEPES Cortisol Buffer
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'hepes-cortisol-buffer',
		name: 'HEPES Cortisol Buffer',
		version: 1,
		status: 'active',
		category: 'cartridge-prep',
		sourceSpreadsheet: 'Cortisol Tracer.xlsx (HEPES Cortisol Buffer sheet)',
		description: 'Cortisol assay running buffer. Base HEPES + BSA + p188 + L-arginine + Glycerol + Proclin, pH-adjusted to 8 at 45°C.',
		parameters: [
			{ key: 'desiredVolume', label: 'Buffer Desired Volume to Prepare', unit: 'uL', type: 'number', defaultValue: 40000 },
			{ key: 'desiredBsaPct', label: 'Desired BSA %', unit: '%', type: 'number', defaultValue: 1.5 },
			{ key: 'desiredP188Pct', label: 'Desired p188 %', unit: '%', type: 'number', defaultValue: 0.2 },
			{ key: 'desiredProclinPct', label: 'Desired Proclin %', unit: '%', type: 'number', defaultValue: 0.05 },
			{ key: 'lArginineMm', label: 'L-arginine Concentration', unit: 'mM', type: 'number', defaultValue: 20 },
			{ key: 'desiredGlycerolPct', label: 'Desired Glycerol %', unit: '%', type: 'number', defaultValue: 2 }
		],
		ratios: [],
		materials: [
			{ key: 'bufferBase', label: 'HEPES Cortisol Buffer Base', type: 'prepared', stockAmount: 45000, stockUnit: 'uL', costPerStockUnit: 3.27 },
			{ key: 'bsa', label: 'BSA Hydrate', type: 'stock', molecularWeight: 66000, stockAmount: 500000, stockUnit: 'mg', costPerStockUnit: 3170 },
			{ key: 'p188', label: 'p188 10% Solution', type: 'stock', defaultConcentration: 10, defaultConcentrationUnit: '%', stockAmount: 100000, stockUnit: 'uL', costPerStockUnit: 33.6 },
			{ key: 'lArginine', label: 'L-arginine', type: 'stock', molecularWeight: 210.66, stockAmount: 100000, stockUnit: 'mg', costPerStockUnit: 57.7 },
			{ key: 'glycerol', label: 'Glycerol 99.5%', type: 'stock', defaultConcentration: 99.5, defaultConcentrationUnit: '%', molecularWeight: 92.09, stockAmount: 1000000, stockUnit: 'uL', costPerStockUnit: 130 },
			{ key: 'proclinInt', label: 'Proclin 5% Intermediate', type: 'prepared', defaultConcentration: 5, defaultConcentrationUnit: '%', stockAmount: 5000, stockUnit: 'uL', costPerStockUnit: 0.6 },
			{ key: 'naoh', label: 'NaOH Solution', type: 'prepared', stockAmount: 20000, stockUnit: 'uL', costPerStockUnit: 1.31 },
			{ key: 'hcl', label: 'HCl Solution', type: 'prepared', stockAmount: 20000, stockUnit: 'uL', costPerStockUnit: 1.98 }
		],
		steps: [
			{ key: 'dissolve-bsa', number: 1, title: 'Dissolve BSA Hydrate', instructions: 'Pipette HEPES Cortisol Buffer Base into a tube (calculated as 95% of desiredVolume minus p188, glycerol, and proclin volumes). Weigh out BSA hydrate and dissolve in the buffer base. Mix with gentle inversion or vortex speed < 1 to minimize foaming. Wait until BSA fully dissolved.', reagents: [{ materialKey: 'bufferBase', label: 'HEPES Buffer Base', formula: '(desiredVolume - p188Vol - glycerolVol - proclinVol) * 0.95', unit: 'uL' }, { materialKey: 'bsa', label: 'BSA Hydrate', formula: 'desiredVolume / (desiredBsaPct * 100)', unit: 'mg' }], observationPrompts: [{ key: 'bsa-dissolved', label: 'Did BSA fully dissolve? Note any visible particles or foaming.' }] },
			{ key: 'add-p188', number: 2, title: 'Add p188', instructions: 'Pipette p188 10% solution. Vortex 10 seconds.', reagents: [{ materialKey: 'p188', label: 'p188 10% Solution', formula: '(desiredVolume * desiredP188Pct) / 10', unit: 'uL' }] },
			{ key: 'add-l-arginine', number: 3, title: 'Add L-arginine', instructions: 'Weigh out L-arginine, dissolve in the buffer. Mix gently — < vortex speed 1.', reagents: [{ materialKey: 'lArginine', label: 'L-arginine', formula: '(lArginineMm / 1000) * (desiredVolume / 1e6) * 210.66 * 1000', unit: 'mg' }] },
			{ key: 'add-glycerol', number: 4, title: 'Add Glycerol', instructions: 'Pipette glycerol. Vortex 10 seconds.', reagents: [{ materialKey: 'glycerol', label: 'Glycerol 99.5%', formula: '(desiredVolume * desiredGlycerolPct) / 99.5', unit: 'uL' }] },
			{ key: 'add-proclin', number: 5, title: 'Add Proclin 300 5% Intermediate', instructions: 'Pipette Proclin intermediate. Vortex 10 seconds.', reagents: [{ materialKey: 'proclinInt', label: 'Proclin 5% Intermediate', formula: '(desiredVolume * desiredProclinPct) / 5', unit: 'uL' }] },
			{ key: 'ph-adjust', number: 6, title: 'Adjust pH to 8 at 45°C', instructions: 'Add NaOH or HCl until pH reaches 8 at 45°C. Predicted NaOH ~ 1550/40000 × desiredVolume uL. Record the actual NaOH volume added. Top up to final desiredVolume with HEPES base. Vortex 10 seconds.', qcCheckpoints: [{ key: 'naoh-added', label: 'Actual NaOH Volume Added', type: 'quantitative', unit: 'uL', helpText: 'Record real volume — drives downstream base top-up calc' }, { key: 'final-ph', label: 'Final pH (at 45°C)', type: 'quantitative', expectedMin: 7.9, expectedMax: 8.1 }] },
			{ key: 'label-store', number: 7, title: 'Label and Store', instructions: 'Barcode the container. Record the barcode in the Reagent Prep Master List. Label with solution name, prep date, preparer initials, and expiration date (1 week from prep). Store in the fridge directly after labeling.' }
		],
		outputSpec: { productName: 'HEPES Cortisol Buffer', volumeUnit: 'uL' }
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Cortisol Bead Mix
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'cortisol-bead-mix',
		name: 'Cortisol Bead Mix',
		version: 2,
		status: 'active',
		category: 'cartridge-prep',
		sourceSpreadsheet: 'Cortisol Cartridge Bead Mix v2 (1).xlsx',
		description: 'Combine Cortisol active beads with Cortisol Buffer to create the bead mix that goes into cartridge well 2.',
		parameters: [
			{ key: 'desiredVolume', label: 'Beads Desired Volume to Prepare', unit: 'uL', type: 'number', defaultValue: 1000 },
			{ key: 'totalBolusMass', label: 'Total Bolus Mass', unit: 'ug', type: 'number', defaultValue: 50 },
			{ key: 'beadsStockConc', label: 'Cortisol Beads Stock Concentration', unit: 'mg/mL', type: 'number', defaultValue: 10 },
			{ key: 'wellVolume', label: 'Well Volume', unit: 'uL', type: 'number', defaultValue: 19 }
		],
		ratios: [],
		materials: [
			{ key: 'cortisolBeads', label: 'Cortisol Active Beads', type: 'prepared', defaultConcentration: 10, defaultConcentrationUnit: 'mg/mL', stockAmount: 2000, stockUnit: 'uL', costPerStockUnit: 409.76, notes: 'Active beads are prepared upstream — no protocol template yet, enter the lot barcode manually.' },
			{ key: 'cortisolBuffer', label: 'Cortisol Buffer', type: 'prepared', canSourceFromSlugs: ['hepes-cortisol-buffer'], stockAmount: 45000, stockUnit: 'uL', costPerStockUnit: 5.49 }
		],
		steps: [
			{ key: 'vortex-beads', number: 1, title: 'Vortex Cortisol Active Beads Stock', instructions: 'Vortex the Cortisol Active Beads stock until the beads are no longer adhering to the side of the tube and are fully suspended (~15 seconds). Magnetic force may be required to fully resuspend.', observationPrompts: [{ key: 'bead-resuspension', label: 'Were the beads fully resuspended before pipetting?' }] },
			{ key: 'prepare-bead-suspension', number: 2, title: 'Prepare Bead Suspension', instructions: 'Pipette the calculated volume of Cortisol Active Beads stock into a tube. Vortex 10 seconds.', reagents: [{ materialKey: 'cortisolBeads', label: 'Cortisol Active Beads Stock', formula: '((desiredVolume / wellVolume) * totalBolusMass) / beadsStockConc', unit: 'uL' }] },
			{ key: 'remove-supernatant', number: 3, title: 'Remove Bead Mix Supernatant', instructions: 'Apply a magnet to the bottom of the container to prevent bead loss while pipetting out the supernatant. If needed, centrifuge for 10 seconds before applying the magnet to aid bead separation.' },
			{ key: 'add-buffer', number: 4, title: 'Add Cortisol Buffer', instructions: 'Pipette Cortisol Buffer to the bead container at the desired final volume.', reagents: [{ materialKey: 'cortisolBuffer', label: 'Cortisol Buffer', formula: 'desiredVolume', unit: 'uL' }] },
			{ key: 'final-vortex-label', number: 5, title: 'Vortex, Barcode and Store', instructions: 'Vortex the entire mixture for 10 seconds after prep. Barcode and label the container. Record the barcode in the Reagent Prep Master List. Label with solution name, prep date, and preparer initials. Store in the fridge directly after labeling.' }
		],
		outputSpec: { productName: 'Cortisol Bead Mix', volumeUnit: 'uL' }
	},

	// ─────────────────────────────────────────────────────────────────────────
	// Cortisol Tracer
	// ─────────────────────────────────────────────────────────────────────────
	{
		slug: 'cortisol-tracer',
		name: 'Cortisol Tracer',
		version: 1,
		status: 'active',
		category: 'cartridge-prep',
		sourceSpreadsheet: 'Cortisol Tracer.xlsx (Cortisol Tracer sheet)',
		description: 'Combine Cortisol SQD and Reference SQD in Cortisol Buffer to make the tracer reagent for cartridge well 3.',
		parameters: [
			{ key: 'desiredVolume', label: 'Tracer Desired Volume to Prepare', unit: 'uL', type: 'number', defaultValue: 18 },
			{ key: 'desiredCortisolTracerConc', label: 'Desired Cortisol Tracer Concentration', unit: 'nM', type: 'number', defaultValue: 0.25 },
			{ key: 'desiredReferenceTracerConc', label: 'Desired Reference Tracer Concentration', unit: 'nM', type: 'number', defaultValue: 0.5 },
			{ key: 'stockCortisolSqdConc', label: 'Stock Cortisol SQD Concentration', unit: 'nM', type: 'number', defaultValue: 10 },
			{ key: 'stockReferenceSqdConc', label: 'Stock Reference SQD Concentration', unit: 'nM', type: 'number', defaultValue: 10 },
			{ key: 'sampleDilution', label: 'Assay Sample Dilution', type: 'number', defaultValue: 0.5 }
		],
		ratios: [],
		materials: [
			{ key: 'cortisolBuffer', label: 'Cortisol Buffer', type: 'prepared', canSourceFromSlugs: ['hepes-cortisol-buffer'], stockAmount: 45000, stockUnit: 'uL', costPerStockUnit: 5.49 },
			{ key: 'cortisolSqd', label: 'Cortisol SQD (from Phase 2)', type: 'prepared', canSourceFromSlugs: ['superqd-phase-2'], stockAmount: 668, stockUnit: 'uL', costPerStockUnit: 107.11, notes: 'Input lot — pick a finalized SuperQD Phase 2 cortisol lot' },
			{ key: 'referenceSqd', label: 'Reference SQD (from Phase 2)', type: 'prepared', canSourceFromSlugs: ['superqd-phase-2'], stockAmount: 668, stockUnit: 'uL', costPerStockUnit: 98.81, notes: 'Input lot — pick a finalized SuperQD Phase 2 chicken/reference lot' }
		],
		steps: [
			{ key: 'sonicate-sqds', number: 1, title: 'Sonicate and Resuspend SQD Stocks', instructions: 'Stock SQD solutions sitting in the fridge need to be properly resuspended before pipetting. Sonicate each for 10 seconds and vortex.', timing: { durationMinutes: 1 } },
			{ key: 'mix-tracer', number: 2, title: 'Combine SQDs in Buffer', instructions: 'Pipette Cortisol Buffer, Cortisol SQD, and Reference SQD into a tube at the calculated volumes (total = desiredVolume).', reagents: [{ materialKey: 'cortisolSqd', label: 'Cortisol SQD', formula: '(desiredCortisolTracerConc * desiredVolume) / stockCortisolSqdConc', unit: 'uL' }, { materialKey: 'referenceSqd', label: 'Reference SQD', formula: '(desiredReferenceTracerConc * desiredVolume) / stockReferenceSqdConc', unit: 'uL' }, { materialKey: 'cortisolBuffer', label: 'Cortisol Buffer', formula: 'desiredVolume - cortisolSqdVolume - referenceSqdVolume', unit: 'uL' }] },
			{ key: 'final-vortex-label', number: 3, title: 'Vortex, Label and Store', instructions: 'Vortex 10 seconds. Label container with mixture name + preparer initials + batch number. Store in the fridge.' }
		],
		outputSpec: { productName: 'Cortisol Tracer', volumeUnit: 'uL' }
	}
];

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;
	const coll = db.collection('reagent_protocol_templates');
	const audit = db.collection('audit_log');

	let created = 0;
	let updated = 0;
	const now = new Date();

	for (const tpl of templates) {
		const existing = await coll.findOne({ slug: tpl.slug, version: tpl.version });
		if (existing) {
			await coll.updateOne(
				{ _id: existing._id },
				{ $set: { ...tpl, updatedAt: now } }
			);
			console.log(`↻ Updated ${tpl.slug} v${tpl.version}`);
			updated++;
		} else {
			const id = nanoid(21);
			await coll.insertOne({ _id: id, ...tpl, createdAt: now, updatedAt: now } as any);
			await audit.insertOne({
				_id: nanoid(21),
				tableName: 'reagent_protocol_templates',
				recordId: id,
				action: 'INSERT',
				changedBy: 'seed-reagent-protocols',
				changedAt: now,
				newData: { slug: tpl.slug, name: tpl.name, version: tpl.version }
			} as any);
			console.log(`✓ Seeded ${tpl.slug} v${tpl.version} (${id})`);
			created++;
		}
	}

	console.log(`\nDone — created ${created}, updated ${updated}.`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
