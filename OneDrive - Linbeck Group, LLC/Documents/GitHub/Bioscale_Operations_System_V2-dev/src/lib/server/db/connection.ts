import mongoose from 'mongoose';
import { env } from '$env/dynamic/private';

let connected = false;

export async function connectDB() {
	if (connected) return;
	if (mongoose.connection.readyState >= 1) {
		connected = true;
		return;
	}
	if (!env.MONGODB_URI) {
		throw new Error('MONGODB_URI is not set');
	}
	await mongoose.connect(env.MONGODB_URI, {
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
