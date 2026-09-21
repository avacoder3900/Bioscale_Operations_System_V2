/**
 * One-off loader (2026-07-31): register the physical scan-label barcodes
 * Alejandro provided for SPU parts as PartDefinition.altBarcodes.
 *
 * Run with the second working copy's .env (has MONGODB_URI):
 *   cd /Users/brevitest/Bioscale_Operations_System_V2 && node <this file>
 *
 * Rules:
 * - Barcodes are stored lowercase (matching the existing `barcode` field).
 * - A barcode equal to the part's existing primary `barcode` is skipped.
 * - $addToSet keeps the script idempotent.
 * - Typos in the source list are corrected here: PT-SPIU-012 -> PT-SPU-012,
 *   "PT- SPU-033" -> PT-SPU-033, and the run-together PT-SPU-092 line.
 * - NOT loaded (parts don't exist yet): PT-SPU-001, PT-SPU-035.
 * - NOT loaded (no part number given): 6A5524CA-..., 9FFC746F-..., 05CEABE6-...,
 *   66A172C0-... — awaiting mapping from Alejandro.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

// [partNumber, barcode] — combined "on line" + "not on line" lists, typos fixed.
const PAIRS = [
	// ---- on-line labels ----
	['PT-SPU-003', '67FD2954-CCD8-4567-8B59-064ED86BECA1'],
	['PT-SPU-002', '5749BAC5-458C-4EA6-B7EF-45811D4E6E41'],
	['PT-SPU-004', 'FDC66ECB-8EC1-4A8A-A0FB-031321122BC5'],
	['PT-SPU-005', '9772B29D-177A-4D9A-9062-74E24DDC5DA7'],
	['PT-SPU-006', '798F0C2C-DE19-428A-A6AB-6CC640B0F455'],
	['PT-SPU-007', 'ADAAE6FC-8501-4C5F-93B9-20E79C8F9ACD'],
	['PT-SPU-008', '916A8365-4C25-4C94-85D0-396DD014219F'],
	['PT-SPU-009', 'B8527F8A-2767-4D2E-9982-9D1142D0F2F8'],
	['PT-SPU-010', 'F43E1925-B9FD-42CD-A8B8-76BFB893E738'],
	['PT-SPU-012', '29A81CC1-B89B-4770-891B-77B2890E3730'], // source said PT-SPIU-012
	['PT-SPU-013', 'C5843F09-61B8-451F-9502-777DF2EF931C'],
	['PT-SPU-046', 'E75E6AF3-860C-4269-9F53-334775C796A5'],
	['PT-SPU-031', '214C7CC4-71FC-41A4-AF7E-81BA6E83EC3C'],
	['PT-SPU-019', 'C1546500-DE6F-429E-8F58-01F3A93F76EA'],
	['PT-SPU-024', 'E28AFEAF-4BB5-422E-9F7A-C2339A226C56'],
	['PT-SPU-029', '417764F3-ED6D-4869-ABF4-85356D3F3BDB'],
	['PT-SPU-091', 'C6FE86A2-9E7B-442C-ADE7-D24DBEB3219B'],
	['PT-SPU-096', '64B513F4-457D-464E-8997-434D49112E9C'],
	['PT-SPU-036', '1FF43528-6200-434D-B87C-C8C711B87491'],
	['PT-SPU-041', '3FC931A8-2553-4618-9DA9-6B42ADD7D072'],
	['PT-SPU-092', 'C99AAB0C-688C-444E-B5BA-D815397D2F1D'],
	['PT-SPU-020', '21A0F8A4-CF87-4668-9CEB-E7DA5B8B71E8'],
	['PT-SPU-028', 'DCD49984-90B6-4BFD-8025-F6B213D492FD'],
	['PT-SPU-002', '18002344-D9BD-49FC-8CB7-EC0C66024F1D'],
	['PT-SPU-034', 'FB464993-D776-40F7-9F0C-A9A13D0E84D3'],
	['PT-SPU-016', 'BAE9DFA8-66D4-4578-A306-BFE348351AFA'],
	['PT-SPU-015', '87269CEA-7F17-4D5E-A27B-EC22831937AE'],
	['PT-SPU-014', 'B7F6D4C4-1F78-485B-9EE2-B9086CD43C0F'],
	['PT-SPU-030', '7568F418-F592-4401-9A5C-70F823F1196C'],
	['PT-SPU-032', '12D159F5-43EA-4A5B-8318-B3BFF7969AB6'],
	['PT-SPU-033', '02AF0E34-6F87-45F4-B5DF-2C9258288F01'], // source said "PT- SPU-033"
	['PT-SPU-052', '020C20B9-9132-4ED2-AB9E-4E3F9B567C9F'],
	['PT-SPU-051', '040A0A8D-07BF-4062-90C7-2C7AE279910E'],
	['PT-SPU-100', '344F2970-512B-4CE1-BA63-ED835A2C734C'],
	// ---- off-line labels (most match the existing primary barcode; those skip) ----
	['PT-SPU-002', 'F70BE9BD-80C9-4B99-840C-B2985CF94046'],
	['PT-SPU-003', '3520A771-1A6C-4D72-B1DA-BB87DC1149DB'],
	['PT-SPU-004', '6CAB6D2E-8ADC-40EC-B9B4-9FC111986B82'],
	['PT-SPU-005', 'AD2EA858-E957-4407-8F07-A544C04F20F9'],
	['PT-SPU-006', '260DB9F4-FE97-463E-9862-AA628BD2D0DB'],
	['PT-SPU-007', 'A2F5243D-343E-4E09-A016-BDD306B57C47'],
	['PT-SPU-008', 'BB37922E-7F63-4A8A-A9D4-317F4457F92F'],
	['PT-SPU-009', '9BB9864E-017D-4EEF-BB9B-42E4A21B4E7A'],
	['PT-SPU-010', '05FDFAFF-00BC-4F81-B8C8-C52184EC203A'],
	['PT-SPU-012', '8A2DEF5E-6A3F-4512-B0C9-3BF5E344EF32'],
	['PT-SPU-013', 'FB5C3CA4-7217-4A25-A679-7D464D3728A8'],
	['PT-SPU-014', '1310D9D3-7734-4356-8DD4-7CE3B598E6AC'],
	['PT-SPU-015', '8546C28F-1889-43D4-8708-D45EB73C93B6'],
	['PT-SPU-017', 'B33AD2E4-C0C7-402A-BF2D-8EE7F8C368F8'],
	['PT-SPU-018', '02A53AE9-1677-4F00-9342-5ED6F7329287'],
	['PT-SPU-019', '9AB1827E-F92D-4908-9C34-78B912EB021B'],
	['PT-SPU-024', '2F9E5793-7351-4425-A3C2-15D83AA3C50D'],
	['PT-SPU-028', 'DCE7F702-8D90-435A-8E4F-3A1E031DCE36'],
	['PT-SPU-029', 'A1F6C439-A5C4-418C-8018-5E6DC63B12EE'],
	['PT-SPU-030', 'EE1BFCA2-C67C-4E2E-9FDA-06835DAF9DFD'],
	['PT-SPU-031', 'EFB40BF6-FEDD-419C-B69E-563A20F4B921'],
	['PT-SPU-032', '3D63FDF0-4A4B-4140-AF0A-15774981AF65'],
	['PT-SPU-033', '11D0A456-EF2C-45A1-A423-25D02EAA3FBB'],
	['PT-SPU-034', '364007E5-3E96-41FC-8F09-DF00591259F4'],
	['PT-SPU-091', 'AB0DEBA5-A7B1-4067-A4F1-7DAFB25ED4A7'],
	['PT-SPU-041', '90A41C50-901A-4E4F-B549-E2EB59F08C6E'],
	['PT-SPU-046', '7C8F0E95-2394-4EED-9710-1311A53080CC'],
	['PT-SPU-051', 'C1B958F9-4619-487D-B044-313F15D9DDA2'],
	['PT-SPU-052', '5A7CA5A5-0EA2-49D5-81CC-2C81D403AA85'],
	['PT-SPU-100', '476DF0C9-8E98-497B-92CC-244321F5B335'],
	['PT-SPU-078', '53157510-A543-4A01-9122-9FAF7CB29D0A'],
	['PT-SPU-082', '40C03AF7-5CC7-4923-8D8A-3CA948399D4C'],
	['PT-SPU-092', '91BA579F-1598-421E-8C77-5DAB6854A837'], // source line was run together
	['PT-SPU-096', 'C07DE722-07E3-4F41-9F83-C5599FA23BEB'],
	['PT-SPU-097', '06155AA6-8AAF-4CD8-A3AD-7C83A040EBDB'],
	['PT-SPU-044', 'CA54AA3C-B234-4590-B643-7A399B77700C'],
	['PT-SPU-027', 'A8841219-426E-41A6-9B08-6BEF842A8633'],
	['PT-SPU-022', 'AEA1DBB6-FA64-4973-A59D-827E2F61797A'],
	['PT-SPU-023', 'ED26A0A8-4B5C-4D74-AD07-504B3CD52077'],
	['PT-SPU-016', 'D1B59B8B-9F0C-4CF3-B5AC-072E223B22C2']
];

(async () => {
	const c = new MongoClient(process.env.MONGODB_URI);
	await c.connect();
	const parts = c.db().collection('part_definitions');
	let added = 0, skippedPrimary = 0, already = 0, missing = 0;

	for (const [partNumber, raw] of PAIRS) {
		const bc = raw.toLowerCase();
		const part = await parts.findOne({ partNumber }, { projection: { barcode: 1, altBarcodes: 1 } });
		if (!part) { console.log('MISSING PART', partNumber, bc); missing++; continue; }
		if (part.barcode === bc) { skippedPrimary++; continue; }
		if ((part.altBarcodes || []).includes(bc)) { already++; continue; }
		await parts.updateOne({ _id: part._id }, { $addToSet: { altBarcodes: bc } });
		added++;
	}
	console.log({ added, skippedPrimary, alreadyPresent: already, missingParts: missing });

	// safety: no barcode may resolve to two different parts
	const dupes = await parts.aggregate([
		{ $project: { partNumber: 1, all: { $concatArrays: [[{ $ifNull: ['$barcode', null] }], { $ifNull: ['$altBarcodes', []] }] } } },
		{ $unwind: '$all' }, { $match: { all: { $ne: null } } },
		{ $group: { _id: '$all', parts: { $addToSet: '$partNumber' }, n: { $sum: 1 } } },
		{ $match: { n: { $gt: 1 } } }
	]).toArray();
	console.log('cross-part duplicate barcodes:', dupes.length ? JSON.stringify(dupes) : 'none');
	await c.close();
})();
