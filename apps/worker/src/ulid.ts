const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID：时间有序、不可猜测（80 位随机数）。 */
export function ulid(now = Date.now()): string {
	let t = now;
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = ALPHABET[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let rand = "";
	for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i]! % 32];
	return time + rand;
}
