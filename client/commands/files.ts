import { existsSync } from "fs";
import { ApiError, api, downloadFile, uploadFile } from "../api";

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
	if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
	return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function progressBar(pct: number): string {
	const filled = Math.floor(pct / 5);
	return `[${"█".repeat(filled)}${" ".repeat(20 - filled)}] ${pct}%`;
}

export async function cmdUpload(args: string[]): Promise<void> {
	const localPath = args[0];
	if (!localPath) {
		console.error("Usage: fileshare upload <path> [--expires <days>]");
		process.exit(1);
	}
	if (!existsSync(localPath)) {
		console.error(`File not found: ${localPath}`);
		process.exit(1);
	}

	const expiresIdx = args.indexOf("--expires");
	const expiresDays =
		expiresIdx >= 0 ? parseInt(args[expiresIdx + 1]!) : undefined;

	const fileInfo = Bun.file(localPath);
	console.log(
		`Uploading: ${localPath.split("/").pop()} (${formatBytes(fileInfo.size)})`,
	);

	try {
		const { file_id, filename } = await uploadFile(localPath, {
			expiresDays,
			onProgress(pct) {
				process.stdout.write(`\r${progressBar(pct)}`);
			},
		});

		process.stdout.write("\r\x1b[K");
		console.log(`✓ Uploaded: ${filename}`);
		console.log(`  File ID: ${file_id}`);
		if (expiresDays) console.log(`  Expires: ${expiresDays} days from now`);
	} catch (err: any) {
		process.stdout.write("\r\x1b[K");
		if (err instanceof ApiError && err.code === "QUOTA_EXCEEDED") {
			console.error(
				`Upload failed: Storage quota exceeded. Upgrade your plan.`,
			);
		} else {
			console.error(`Upload failed: ${err.message}`);
		}
		process.exit(1);
	}
}

export async function cmdDownload(args: string[]): Promise<void> {
	const fileId = args[0];
	if (!fileId) {
		console.error("Usage: fileshare download <file-id> [--output <path>]");
		process.exit(1);
	}

	const outputIdx = args.indexOf("--output");
	let destPath = outputIdx >= 0 ? args[outputIdx + 1] : undefined;

	try {
		const meta = (await api.files.getMeta(fileId)) as any;
		destPath ??= meta.filename;

		console.log(`Downloading: ${meta.filename} (${formatBytes(meta.size)})`);

		await downloadFile(fileId, destPath!, {
			onProgress(pct, total) {
				process.stdout.write(`\r${progressBar(pct)} ${formatBytes(total)}`);
			},
		});

		process.stdout.write("\r\x1b[K");
		console.log(`✓ Saved to: ${destPath}`);
	} catch (err: any) {
		process.stdout.write("\r\x1b[K");
		console.error(`Download failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdList(args: string[]): Promise<void> {
	const pageIdx = args.indexOf("--page");
	const page = pageIdx >= 0 ? parseInt(args[pageIdx + 1]!) : 1;

	try {
		const data = (await api.files.list(page)) as any;

		if (data.files.length === 0 && data.shared.length === 0) {
			console.log("No files yet. Upload with: fileshare upload <path>");
			return;
		}

		if (data.files.length > 0) {
			console.log("\nYour files:");
			console.log("─".repeat(80));
			for (const f of data.files) {
				const exp = f.expires_at
					? ` [expires ${f.expires_at.slice(0, 10)}]`
					: "";
				console.log(
					`  ${f.id}  ${f.filename.padEnd(30)} ${formatBytes(f.size).padStart(10)}${exp}`,
				);
			}
			console.log(`  (${data.total} total, page ${data.page})`);
		}

		if (data.shared.length > 0) {
			console.log("\nShared with you:");
			console.log("─".repeat(80));
			for (const f of data.shared) {
				const rw = f.can_write ? "[rw]" : "[ro]";
				console.log(
					`  ${f.id}  ${f.filename.padEnd(30)} ${formatBytes(f.size).padStart(10)} ${rw}`,
				);
			}
		}
	} catch (err: any) {
		console.error(`List failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdInfo(args: string[]): Promise<void> {
	const fileId = args[0];
	if (!fileId) {
		console.error("Usage: fileshare info <file-id>");
		process.exit(1);
	}

	try {
		const f = (await api.files.getMeta(fileId)) as any;
		console.log(`ID:       ${f.id}`);
		console.log(`Name:     ${f.filename}`);
		console.log(`Size:     ${formatBytes(f.size)}`);
		console.log(`Type:     ${f.mime_type}`);
		console.log(`Status:   ${f.status}`);
		console.log(`Created:  ${f.created_at}`);
		console.log(`Expires:  ${f.expires_at || "never"}`);
		if (f.shares?.length > 0) {
			console.log(
				`Shared:   ${f.shares.map((s: any) => `${s.username} (${s.can_write ? "rw" : "ro"})`).join(", ")}`,
			);
		}
	} catch (err: any) {
		console.error(`Failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdDelete(args: string[]): Promise<void> {
	const fileId = args[0];
	if (!fileId) {
		console.error("Usage: fileshare delete <file-id>");
		process.exit(1);
	}

	try {
		await api.files.delete(fileId);
		console.log(`✓ Deleted ${fileId}`);
	} catch (err: any) {
		console.error(`Delete failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdShare(args: string[]): Promise<void> {
	const fileId = args[0];
	const usernameIdx = args.indexOf("--user");
	const username = usernameIdx >= 0 ? args[usernameIdx + 1] : undefined;

	if (!fileId || !username) {
		console.error(
			"Usage: fileshare share <file-id> --user <username> [--write]",
		);
		process.exit(1);
	}

	const canWrite = args.includes("--write");

	try {
		await api.files.share(fileId, username, canWrite);
		console.log(
			`✓ Shared ${fileId} with ${username} (${canWrite ? "read-write" : "read-only"})`,
		);
	} catch (err: any) {
		console.error(`Share failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdUnshare(args: string[]): Promise<void> {
	const fileId = args[0];
	const usernameIdx = args.indexOf("--user");
	const username = usernameIdx >= 0 ? args[usernameIdx + 1] : undefined;

	if (!fileId || !username) {
		console.error("Usage: fileshare unshare <file-id> --user <username>");
		process.exit(1);
	}

	try {
		await api.files.unshare(fileId, username);
		console.log(`✓ Removed ${username}'s access to ${fileId}`);
	} catch (err: any) {
		console.error(`Unshare failed: ${err.message}`);
		process.exit(1);
	}
}
