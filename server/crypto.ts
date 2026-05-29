import {
	createCipheriv,
	createDecipheriv,
	createHash,
	pbkdf2Sync,
	randomBytes,
} from "crypto";

// 8-byte cleartext_size + 12-byte IV + 16-byte GCM tag prepended to each encrypted chunk
export const CHUNK_HEADER_SIZE = 36;

function getMasterKey(): Buffer {
	const k = process.env.MASTER_KEY;
	if (k && k.length === 64) return Buffer.from(k, "hex");
	// Dev fallback: derive from JWT_SECRET. Set MASTER_KEY explicitly in production.
	const fallback = process.env.JWT_SECRET || "change-this-secret";
	return createHash("sha256")
		.update("master:" + fallback)
		.digest();
}

export function generateFileKey(): Buffer {
	return randomBytes(32);
}

function aesgcmEncrypt(
	data: Buffer,
	key: Buffer,
): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
	return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function aesgcmDecrypt(
	ciphertext: Buffer,
	key: Buffer,
	iv: Buffer,
	tag: Buffer,
): Buffer {
	const decipher = createDecipheriv("aes-256-gcm", key, iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ----- Key wrapping -----

export function wrapKey(fileKey: Buffer): {
	wrapped: string;
	iv: string;
	tag: string;
} {
	const { ciphertext, iv, tag } = aesgcmEncrypt(fileKey, getMasterKey());
	return {
		wrapped: ciphertext.toString("hex"),
		iv: iv.toString("hex"),
		tag: tag.toString("hex"),
	};
}

export function unwrapKey(wrapped: string, iv: string, tag: string): Buffer {
	return aesgcmDecrypt(
		Buffer.from(wrapped, "hex"),
		getMasterKey(),
		Buffer.from(iv, "hex"),
		Buffer.from(tag, "hex"),
	);
}

// Password-derived key wrapping (E2E for password share links)
export function wrapKeyWithPassword(
	fileKey: Buffer,
	password: string,
): { wrapped: string; iv: string; tag: string; salt: string } {
	const salt = randomBytes(32);
	const derivedKey = pbkdf2Sync(password, salt, 600_000, 32, "sha256");
	const { ciphertext, iv, tag } = aesgcmEncrypt(fileKey, derivedKey);
	return {
		wrapped: ciphertext.toString("hex"),
		iv: iv.toString("hex"),
		tag: tag.toString("hex"),
		salt: salt.toString("hex"),
	};
}

export function unwrapKeyWithPassword(
	wrapped: string,
	iv: string,
	tag: string,
	salt: string,
	password: string,
): Buffer {
	const derivedKey = pbkdf2Sync(
		password,
		Buffer.from(salt, "hex"),
		600_000,
		32,
		"sha256",
	);
	return aesgcmDecrypt(
		Buffer.from(wrapped, "hex"),
		derivedKey,
		Buffer.from(iv, "hex"),
		Buffer.from(tag, "hex"),
	);
}

// ----- Chunk encryption -----
// On-disk format per chunk: [8-byte cleartext_size BE][12-byte IV][16-byte GCM tag][ciphertext]

export function encryptChunk(data: Buffer, key: Buffer): Buffer {
	const { ciphertext, iv, tag } = aesgcmEncrypt(data, key);
	const header = Buffer.alloc(CHUNK_HEADER_SIZE);
	header.writeBigUInt64BE(BigInt(data.length), 0);
	iv.copy(header, 8);
	tag.copy(header, 20);
	return Buffer.concat([header, ciphertext]);
}

export function decryptChunk(encryptedChunk: Buffer, key: Buffer): Buffer {
	const cleartextSize = Number(encryptedChunk.readBigUInt64BE(0));
	const iv = encryptedChunk.subarray(8, 20);
	const tag = encryptedChunk.subarray(20, 36);
	const ciphertext = encryptedChunk.subarray(36, 36 + cleartextSize);
	return aesgcmDecrypt(ciphertext, key, iv, tag);
}
