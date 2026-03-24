import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

await mongoose.connect(process.env.MONGODB_URI!);
const db = mongoose.connection.db!;

const missed = [
	'agentmessages',
	'assemblysessions',
	'cartridgegroups',
	'deviceevents',
	'electronicsignatures',
	'firmwarecartridges',
	'firmwaredevices',
	'invitetokens',
	'lasercutbatches',
	'manufacturingmaterials',
	'manufacturingmaterialtransactions',
	'productionruns',
	'routingpatterns',
	'systemdependencies',
	'testresults',
	'workinstructions',
	'bom_column_mapping',
];

for (const name of missed) {
	try {
		const count = await db.collection(name).countDocuments();
		console.log(`${name}: ${count} docs`);
	} catch {
		console.log(`${name}: NOT FOUND`);
	}
}

await mongoose.disconnect();
