export const CHUNK_SIZE = 100 * 1024 * 1024; // 100MB per chunk for upload/download

export const SUBSCRIPTION_LIMITS = {
	free: { storage: 1 * 1024 ** 3 },
	pro: { storage: 10 * 1024 ** 3 },
	full: { storage: Infinity },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_LIMITS;
export type UserRole = "user" | "admin";
export type FileStatus = "uploading" | "complete" | "error";
export type Platform =
	| "linux-x64"
	| "linux-arm64"
	| "darwin-x64"
	| "darwin-arm64"
	| "windows-x64";

export interface User {
	id: number;
	username: string;
	role: UserRole;
	subscription_tier: SubscriptionTier;
	storage_used: number;
	created_at: string;
}

export interface FileRecord {
	id: string;
	owner_id: number;
	filename: string;
	size: number;
	mime_type: string;
	status: FileStatus;
	bytes_received: number;
	created_at: string;
	expires_at: string | null;
}

export interface FileShare {
	file_id: string;
	user_id: number;
	can_write: boolean;
	created_at: string;
}

export interface ClientVersion {
	id: number;
	version: string;
	platform: Platform;
	filename: string;
	sha256: string;
	is_latest: boolean;
	created_at: string;
}

export interface TokenPayload {
	userId: number;
	username: string;
	role: UserRole;
}

export interface ApiError {
	error: string;
	code?: string;
}

export interface UploadInitResponse {
	file_id: string;
	chunk_size: number;
}

export interface VersionInfo {
	version: string;
	platform: Platform;
	download_url: string;
	sha256: string;
}
