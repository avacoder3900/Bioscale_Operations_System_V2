import { redirect } from '@sveltejs/kit';
import { connectDB, ShippingLot, ShippingPackage, CartridgeRecord, Customer, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'shipping:read');

	await connectDB();

	const tab = url.searchParams.get('tab') || 'lots';
	const page = parseInt(url.searchParams.get('page') || '1');
	const limit = 50;

	const [lots, lotsTotal, packages, packagesTotal] = await Promise.all([
		ShippingLot.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		ShippingLot.countDocuments(),
		ShippingPackage.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
		ShippingPackage.countDocuments()
	]);

	return {
		tab,
		lots: lots.map((l: any) => ({
			id: l._id,
			assayType: l.assayType,
			customer: l.customer,
			status: l.status,
			cartridgeCount: l.cartridgeCount ?? 0,
			releasedAt: l.releasedAt,
			releasedBy: l.releasedBy,
			notes: l.notes,
			qaqcReleases: l.qaqcReleases ?? [],
			createdAt: l.createdAt,
			updatedAt: l.updatedAt
		})),
		packages: packages.map((p: any) => ({
			id: p._id,
			barcode: p.barcode,
			customer: p.customer,
			trackingNumber: p.trackingNumber,
			carrier: p.carrier,
			status: p.status,
			notes: p.notes,
			packedBy: p.packedBy,
			packedAt: p.packedAt,
			shippedAt: p.shippedAt,
			deliveredAt: p.deliveredAt,
			cartridges: p.cartridges ?? [],
			createdAt: p.createdAt,
			updatedAt: p.updatedAt
		})),
		pagination: {
			page,
			limit,
			lotsTotal,
			packagesTotal,
			hasNext: tab === 'lots' ? page * limit < lotsTotal : page * limit < packagesTotal,
			hasPrev: page > 1
		}
	};
};

export const actions: Actions = {
	createLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const assayId = data.get('assayId') as string;
		const assayName = data.get('assayName') as string;
		const customerId = data.get('customerId') as string;
		const customerName = data.get('customerName') as string;
		const notes = data.get('notes') as string;

		await ShippingLot.create({
			assayType: { _id: assayId, name: assayName },
			customer: { _id: customerId, name: customerName },
			status: 'open',
			cartridgeCount: 0,
			notes: notes || undefined,
			qaqcReleases: []
		});

		return { success: true };
	},

	updateLotStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const status = data.get('status') as string;

		const update: any = { status };
		if (status === 'released') {
			update.releasedAt = new Date();
			update.releasedBy = locals.user.username;
		}

		await ShippingLot.findByIdAndUpdate(lotId, update);
		return { success: true };
	},

	addQaqcRelease: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const reagentRunId = data.get('reagentRunId') as string;
		const qaqcCartridgeIds = (data.get('qaqcCartridgeIds') as string || '').split(',').filter(Boolean);
		const testResult = data.get('testResult') as string;
		const notes = data.get('notes') as string;

		await ShippingLot.findByIdAndUpdate(lotId, {
			$push: {
				qaqcReleases: {
					reagentRunId,
					qaqcCartridgeIds,
					testResult: testResult || 'pending',
					testedBy: { _id: locals.user._id, username: locals.user.username },
					testedAt: testResult !== 'pending' ? new Date() : undefined,
					notes: notes || undefined,
					createdAt: new Date()
				}
			}
		});

		return { success: true };
	},

	createPackage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const customerId = data.get('customerId') as string;
		const barcode = data.get('barcode') as string;
		const carrier = data.get('carrier') as string;
		const notes = data.get('notes') as string;

		// Fetch full customer snapshot
		const customer = await Customer.findById(customerId).lean() as any;
		if (!customer) return { success: false, error: 'Customer not found' };

		await ShippingPackage.create({
			barcode: barcode || undefined,
			customer: {
				_id: customer._id,
				name: customer.name,
				customerType: customer.customerType,
				contactName: customer.contactName,
				contactEmail: customer.contactEmail,
				contactPhone: customer.contactPhone,
				address: customer.address
			},
			carrier: carrier || undefined,
			status: 'created',
			notes: notes || undefined,
			cartridges: []
		});

		return { success: true };
	},

	addCartridgeToPackage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const packageId = data.get('packageId') as string;
		const cartridgeId = data.get('cartridgeId') as string;

		// Get package snapshot for customer/tracking data
		const pkg = await ShippingPackage.findById(packageId, {
			barcode: 1, customer: 1, trackingNumber: 1, carrier: 1
		}).lean() as any;

		await ShippingPackage.findByIdAndUpdate(packageId, {
			$push: { cartridges: { cartridgeId, addedAt: new Date() } }
		});

		const now = new Date();

		// Write shipping subdoc to CartridgeRecord DMR (correct field, not phantom phases[])
		await CartridgeRecord.findByIdAndUpdate(cartridgeId, {
			$set: {
				'shipping.packageId': packageId,
				'shipping.packageBarcode': pkg?.barcode ?? undefined,
				'shipping.customer': pkg?.customer ?? undefined,
				'shipping.trackingNumber': pkg?.trackingNumber ?? undefined,
				'shipping.carrier': pkg?.carrier ?? undefined,
				'shipping.shippedAt': now,
				'shipping.recordedAt': now,
				currentPhase: 'shipped'
			}
		});

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cartridgeId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { currentPhase: 'shipped', 'shipping.packageId': packageId }
		});

		return { success: true };
	},

	updatePackageStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'shipping:write');
		await connectDB();

		const data = await request.formData();
		const packageId = data.get('packageId') as string;
		const status = data.get('status') as string;
		const trackingNumber = data.get('trackingNumber') as string;

		const update: any = { status };
		if (trackingNumber) update.trackingNumber = trackingNumber;
		if (status === 'packed') {
			update.packedBy = locals.user.username;
			update.packedAt = new Date();
		} else if (status === 'shipped') {
			update.shippedAt = new Date();
		} else if (status === 'delivered') {
			update.deliveredAt = new Date();
		}

		await ShippingPackage.findByIdAndUpdate(packageId, update);
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
