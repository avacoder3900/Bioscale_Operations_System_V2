/**
 * Dev tool: send ZPL to a Zebra printer through a local Zebra Browser Print
 * agent (no BIMS, no minting). Useful for bench-testing layout/calibration
 * from the command line on the PC the printer is attached to.
 *
 *   npx tsx scripts/zebra-send.ts align                      # alignment row (default cfg)
 *   npx tsx scripts/zebra-send.ts align --x=4 --y=-2         # with offsets (dots)
 *   npx tsx scripts/zebra-send.ts labels <uuid> [<uuid>...]  # real label layout for given codes
 *   npx tsx scripts/zebra-send.ts raw "<zpl>"                # send arbitrary ZPL
 *   npx tsx scripts/zebra-send.ts status                     # ~HS host status
 *   npx tsx scripts/zebra-send.ts list                       # printers the agent sees
 *
 * Options: --printer=<uid|name> (default: first printer), --dpi=203|300, --w=0.75 --h=0.75 (label in),
 *          --gap=0.125, --x=0 --y=0 (dots), --mag=3, --dark=<0-30>, --dry (print ZPL, don't send)
 */
import { buildAlignmentZpl, buildCartridgeLabelsZpl, buildRulerZpl, ZT230_2X_075_DEFAULTS, type ZebraLabelConfig } from '../src/lib/zebra/cartridge-label-zpl';

const BASE = process.env.BROWSER_PRINT_URL ?? 'http://localhost:9100';
const args = process.argv.slice(2);
const cmd = args[0] ?? 'list';
const opt = (k: string): string | undefined => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const flag = (k: string) => args.includes(`--${k}`);
const positional = args.slice(1).filter((a) => !a.startsWith('--'));

interface Dev { name: string; uid: string; connection: string; deviceType: string; version?: number; provider?: string; manufacturer?: string }

async function listPrinters(): Promise<Dev[]> {
	const r = await fetch(`${BASE}/available`);
	const j = (await r.json()) as { printer?: Dev[] };
	return j.printer ?? [];
}
async function write(device: Dev, data: string): Promise<string> {
	const r = await fetch(`${BASE}/write`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ device, data }) });
	return `${r.status} ${await r.text()}`;
}
async function read(device: Dev): Promise<string> {
	const r = await fetch(`${BASE}/read`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ device }) });
	return await r.text();
}

const cfg: ZebraLabelConfig = {
	...ZT230_2X_075_DEFAULTS,
	dpi: Number(opt('dpi') ?? ZT230_2X_075_DEFAULTS.dpi),
	labelWidthIn: Number(opt('w') ?? ZT230_2X_075_DEFAULTS.labelWidthIn),
	labelHeightIn: Number(opt('h') ?? ZT230_2X_075_DEFAULTS.labelHeightIn),
	columnGapIn: Number(opt('gap') ?? ZT230_2X_075_DEFAULTS.columnGapIn),
	offsetX: Number(opt('x') ?? 0),
	offsetY: Number(opt('y') ?? 0),
	qrMagnification: Number(opt('mag') ?? ZT230_2X_075_DEFAULTS.qrMagnification),
	darkness: opt('dark') !== undefined ? Number(opt('dark')) : undefined
};

const printers = await listPrinters();
if (cmd === 'list') {
	console.log(JSON.stringify(printers, null, 2));
	process.exit(0);
}
const want = opt('printer');
const device = want ? printers.find((p) => p.uid === want || p.name === want) : printers[0];
if (!device) {
	console.error(`No printer${want ? ` matching ${want}` : ''}. Agent sees: ${JSON.stringify(printers)}`);
	process.exit(1);
}
console.error(`→ ${device.name} (${device.connection})`);

let zpl: string;
switch (cmd) {
	case 'align': zpl = buildAlignmentZpl(cfg).zpl; break;
	case 'ruler': zpl = buildRulerZpl(cfg).zpl; break;
	case 'labels': {
		if (!positional.length) { console.error('labels: give at least one uuid'); process.exit(1); }
		zpl = buildCartridgeLabelsZpl(positional, cfg).zpl; break;
	}
	case 'raw': zpl = positional.join(' '); break;
	case 'status': {
		console.log(await write(device, '~HS'));
		await new Promise((r) => setTimeout(r, 800));
		console.log(JSON.stringify(await read(device)));
		process.exit(0);
	}
	default: console.error(`unknown command ${cmd}`); process.exit(1);
}
console.log(zpl);
if (flag('dry')) process.exit(0);
console.log('write:', await write(device, zpl));
