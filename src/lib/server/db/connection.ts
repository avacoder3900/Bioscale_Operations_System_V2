import mongoose from 'mongoose';

// Use process.env directly so this module can be imported from non-SvelteKit
// contexts (test scripts, CLI tools). In SvelteKit production runtime,
// process.env is populated identically to $env/dynamic/private — both are
// thin wrappers over Node's process.env on Vercel.

let connected = false;

export async function connectDB() {
	if (connected) return;
	if (mongoose.connection.readyState >= 1) {
		connected = true;
		return;
	}
	const uri = process.env.MONGODB_URI;
	if (!uri) {
		throw new Error('MONGODB_URI is not set');
	}
	await mongoose.connect(uri, {
		serverSelectionTimeoutMS: 5000,
		connectTimeoutMS: 5000,
		socketTimeoutMS: 10000,
		maxPoolSize: 10,
		minPoolSize: 1
	});
	connected = true;
	console.log('MongoDB connected');
}

export { mongoose };
