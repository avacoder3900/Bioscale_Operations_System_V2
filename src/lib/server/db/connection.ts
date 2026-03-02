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
	await mongoose.connect(env.MONGODB_URI);
	connected = true;
	console.log('MongoDB connected');
}

export { mongoose };
