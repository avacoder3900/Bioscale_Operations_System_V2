import { describe, expect, it } from 'vitest';
import { initialsOf, parseInitialsMap, resolveInitials } from './speakers';

const users = [
	{ _id: 'u1', username: 'jacob', firstName: 'Jacob', lastName: 'Quick' },
	{ _id: 'u2', username: 'Giovanni Victorio', firstName: 'Giovanni', lastName: 'Victorio' },
	{ _id: 'u3', username: 'alejandro', firstName: 'Alejandro', lastName: 'Valdez' },
	{ _id: 'u4', username: 'viewer1', firstName: 'Test', lastName: 'Viewer' },
	{ _id: 'u5', username: 'Test Viewer 2', firstName: 'Test', lastName: 'Viewer 2' },
	{ _id: 'u6', username: 'l3', firstName: 'L3', lastName: '' }
];

describe('initialsOf', () => {
	it('first letters of first + last name', () => {
		expect(initialsOf(users[0])).toBe('JQ');
		expect(initialsOf({ firstName: 'yuritzy', lastName: 'Cardenas' })).toBe('YC');
		expect(initialsOf(users[5])).toBeNull();
	});
});

describe('resolveInitials', () => {
	it('maps initials to the one person who has them', () => {
		expect(resolveInitials(['GV'], users)).toEqual({ user: users[1], initials: 'GV' });
		expect(resolveInitials(['av'], users)?.user.username).toBe('alejandro');
	});

	it('skips candidates that are not anyone, and takes the next', () => {
		expect(resolveInitials(['ON'], users)).toBeNull();
		expect(resolveInitials(['NOV', 'JQ'], users)?.user.username).toBe('jacob');
	});

	it('never guesses between two people with the same initials', () => {
		expect(resolveInitials(['TV'], users)).toBeNull();
	});

	it('an override wins, and can break a tie or add a nickname', () => {
		const map = parseInitialsMap(' tv:viewer1 , GIO:Giovanni Victorio, bad, XX:nobody ');
		expect(resolveInitials(['TV'], users, map)?.user.username).toBe('viewer1');
		expect(resolveInitials(['GIO'], users, map)?.user.username).toBe('Giovanni Victorio');
		expect(resolveInitials(['XX'], users, map)).toBeNull();
	});
});
