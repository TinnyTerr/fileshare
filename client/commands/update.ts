import { ApiError, api } from "../api";
import { loadConfig, saveConfig } from "../config";

function detectPlatform(): string {
	const os = process.platform;
	const arch = process.arch;
	if (os === "linux" && arch === "x64") return "linux-x64";
	if (os === "linux" && arch === "arm64") return "linux-arm64";
	if (os === "darwin" && arch === "x64") return "darwin-x64";
	if (os === "darwin" && arch === "arm64") return "darwin-arm64";
	if (os === "win32" && arch === "x64") return "windows-x64";
	return "linux-x64";
}

function semverGt(a: string, b: string): boolean {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
		if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
	}
	return false;
}

export async function cmdVersion(): Promise<void> {
	const cfg = loadConfig();
	console.log(`fileshare client version ${cfg.client_version}`);
	console.log(`Server: ${cfg.server}`);
	console.log(`Platform: ${detectPlatform()}`);
}

export async function cmdCheckUpdate(silent = false): Promise<void> {
	const cfg = loadConfig();
	try {
		const info = (await api.version.latest(detectPlatform())) as any;
		if (semverGt(info.version, cfg.client_version)) {
			console.log(`Update available: ${cfg.client_version} → ${info.version}`);
			console.log(`Run "fileshare update" to install.`);
		} else if (!silent) {
			console.log(`You are up to date (${cfg.client_version})`);
		}
	} catch (err: any) {
		if (!silent) console.error(`Could not check for updates: ${err.message}`);
	}
}

export async function cmdUpdate(args: string[]): Promise<void> {
	const cfg = loadConfig();
	const platform = detectPlatform();
	const force = args.includes("--force");

	console.log(`Checking for updates (platform: ${platform})...`);

	let info: any;
	try {
		info = await api.version.latest(platform);
	} catch (err: any) {
		console.error(`Update check failed: ${err.message}`);
		process.exit(1);
	}

	const latest = info.version as string;
	if (!force && !semverGt(latest, cfg.client_version)) {
		console.log(`Already up to date (${cfg.client_version})`);
		return;
	}

	console.log(`Downloading ${cfg.client_version} → ${latest}...`);

	const res = await fetch(info.download_url);
	if (!res.ok) {
		console.error(`Download failed: ${res.statusText}`);
		process.exit(1);
	}

	const binary = await res.arrayBuffer();

	// Verify SHA256
	const buf = await crypto.subtle.digest("SHA-256", binary);
	const actualHash = Buffer.from(buf).toString("hex");
	if (actualHash !== info.sha256) {
		console.error(
			"SHA256 mismatch — update rejected. Binary may be corrupted or tampered.",
		);
		process.exit(1);
	}

	const selfPath = process.execPath;
	const tmpPath = `${selfPath}.new`;

	await Bun.write(tmpPath, binary);

	if (process.platform === "win32") {
		await replaceOnWindows(selfPath, tmpPath, latest);
	} else {
		const { chmodSync, renameSync } = await import("fs");
		chmodSync(tmpPath, 0o755);
		renameSync(tmpPath, selfPath);
		saveConfig({ client_version: latest });
		console.log(
			`✓ Updated to ${latest}. Restart fileshare to use the new version.`,
		);
	}
}

// On Windows, you can't replace a running executable.
// Write a .bat that waits for this process to exit, then swaps the files.
async function replaceOnWindows(
	selfPath: string,
	tmpPath: string,
	newVersion: string,
): Promise<void> {
	const batPath = `${selfPath}.update.bat`;
	const batContent = [
		"@echo off",
		`set "PID=${process.pid}"`,
		`set "OLD=${selfPath}"`,
		`set "NEW=${tmpPath}"`,
		// Wait until the current process exits (poll every 500ms)
		":waitloop",
		`  tasklist /fi "pid eq %PID%" 2>nul | find "%PID%" >nul 2>&1`,
		"  if not errorlevel 1 (",
		"    timeout /t 1 /nobreak >nul",
		"    goto waitloop",
		"  )",
		`move /y "%NEW%" "%OLD%" >nul`,
		`del "%~f0"`, // self-delete the .bat
	].join("\r\n");

	await Bun.write(batPath, batContent);

	const { spawn } = await import("child_process");
	spawn("cmd", ["/c", batPath], { detached: true, stdio: "ignore", windowsHide: true }).unref();

	saveConfig({ client_version: newVersion });
	console.log(
		`✓ Updater launched. The binary will be replaced after you exit.`,
	);
	console.log(`  Restart fileshare to use version ${newVersion}.`);
	process.exit(0);
}
