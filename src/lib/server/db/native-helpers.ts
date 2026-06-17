/**
 * Helpers for the raw MongoDB native driver (`db.collection(...)`).
 *
 * Mongoose models are typed correctly for our nanoid-string `_id` convention,
 * but the native driver's TS types declare `_id: ObjectId` because the driver
 * doesn't know about our custom IDs. Calls like
 * `db.collection('foo').findOne({ _id: someStringId })` therefore error with
 * `Type 'string' is not assignable to type 'Condition<ObjectId>'`.
 *
 * Use these helpers at every native-driver call site where `_id` is a
 * nanoid string. Cast lives in one place, intent is greppable, type
 * checking on the rest of the filter object stays intact.
 */
import type { Filter, ObjectId } from 'mongodb';

/** Build a filter that matches by string `_id`. */
export function byId(id: string): Filter<any> {
	return { _id: id as unknown as ObjectId };
}

/** Cast a string `_id` for use in an `insertOne` payload or `$set` field. */
export function asId(id: string): ObjectId {
	return id as unknown as ObjectId;
}
