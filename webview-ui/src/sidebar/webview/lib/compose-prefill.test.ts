// The composer prefill ownership predicate (review round-2, issue): a host
// `compose` note must land ONLY in the composer already showing the owning
// session. The regression this pins: the draft (home) composer mounts with
// `sessionId === null`, and an `owner && current && owner !== current` guard
// short-circuited past the null and leaked a foreign `/codechain …` into a
// fresh thread.

import { describe, expect, it } from 'vitest';

import { shouldApplyComposePrefill } from './compose-prefill';

describe('shouldApplyComposePrefill', () => {
	it('applies when the composer shows the owning session', () => {
		expect(shouldApplyComposePrefill('s1', 's1')).toBe(true);
	});

	it('drops when the composer shows a DIFFERENT session', () => {
		expect(shouldApplyComposePrefill('s1', 's2')).toBe(false);
	});

	it('drops on the draft composer (current session is null) — the null-session branch', () => {
		// The exact case the old `owner && current && …` guard got wrong:
		// `current` null must NOT let a note addressed to 's1' through.
		expect(shouldApplyComposePrefill('s1', null)).toBe(false);
	});

	it('drops a malformed note with an empty owner (host never sends one)', () => {
		expect(shouldApplyComposePrefill('', 's1')).toBe(false);
		expect(shouldApplyComposePrefill('', null)).toBe(false);
	});
});
