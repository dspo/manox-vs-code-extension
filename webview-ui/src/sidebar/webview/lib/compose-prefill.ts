// Pure ownership predicate for a host `compose` prefill (review round-2,
// issue). The composer subscribes once and lives across thread switches,
// so the long-lived callback must decide, per note, whether the note belongs
// to the thread CURRENTLY on screen. The failure this guards against: the
// draft (home) composer is mounted with `sessionId === null`, so a naive
// `owner && current && owner !== current` guard short-circuits to "accept"
// on a null-current composer and leaks another session's `/codechain …` into
// a brand-new thread. The rule is therefore strictly: apply only when the
// composer has a concrete session AND it matches the note's owner.
//
// The host side upholds the mirror contract — a `compose` note is never sent
// without a real owning session (see `panel.ts` regen) — so an empty/nullish
// owner here is a malformed note and is dropped too.

export function shouldApplyComposePrefill(owner: string, current: string | null): boolean {
	return current !== null && owner !== '' && owner === current;
}
