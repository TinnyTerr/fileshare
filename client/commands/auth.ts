import { createInterface } from "readline";
import { api } from "../api";
import { clearAuth, loadConfig, saveConfig } from "../config";

async function promptText(msg: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	return new Promise((resolve) => {
		rl.question(msg, (answer) => {
			rl.close();
			resolve(answer);
		});
	});
}

async function promptPassword(msg: string): Promise<string> {
	// Use readline with muted output where possible
	process.stdout.write(msg);

	// On Windows / CI / non-TTY: read normally (muting isn't safe)
	if (!process.stdin.isTTY || process.platform === "win32") {
		const rl = createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		return new Promise((resolve) => {
			rl.question("", (answer) => {
				rl.close();
				process.stdout.write("\n");
				resolve(answer);
			});
		});
	}

	// POSIX TTY: suppress echo via setRawMode
	return new Promise((resolve) => {
		let input = "";
		process.stdin.setRawMode!(true);
		process.stdin.resume();
		process.stdin.setEncoding("utf8");

		const handler = (ch: string) => {
			if (ch === "\r" || ch === "\n") {
				process.stdin.removeListener("data", handler);
				process.stdin.setRawMode!(false);
				process.stdin.pause();
				process.stdout.write("\n");
				resolve(input);
			} else if (ch === "") {
				process.exit(0);
			} else if (ch === "") {
				input = input.slice(0, -1);
			} else {
				input += ch;
			}
		};

		process.stdin.on("data", handler);
	});
}

export async function cmdLogin(args: string[]): Promise<void> {
	let username = args[0];
	let password = args[1];

	if (!username) username = await promptText("username: ");
	if (!password) password = await promptPassword("Password: ");

	try {
		const data = (await api.auth.login(username, password)) as any;
		saveConfig({
			username: data.user.username,
			access_token: data.access_token,
			refresh_token: data.refresh_token,
		});
		console.log(
			`✓ Logged in as ${data.user.username} (${data.user.subscription_tier})`,
		);
	} catch (err: any) {
		console.error(`Login failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdRegister(args: string[]): Promise<void> {
	let username = args[0];
	let password = args[1];

	if (!username) username = await promptText("username: ");
	if (!password) {
		password = await promptPassword("Password: ");
		const confirm = await promptPassword("Confirm password: ");
		if (password !== confirm) {
			console.error("Passwords do not match");
			process.exit(1);
		}
	}

	try {
		const data = (await api.auth.register(username, password)) as any;
		saveConfig({
			username: data.user.username,
			access_token: data.access_token,
			refresh_token: data.refresh_token,
		});
		console.log(`✓ Registered and logged in as ${data.user.username}`);
	} catch (err: any) {
		console.error(`Registration failed: ${err.message}`);
		process.exit(1);
	}
}

export async function cmdLogout(): Promise<void> {
	const cfg = loadConfig();
	if (cfg.refresh_token) {
		await api.auth.logout(cfg.refresh_token).catch(() => {});
	}
	clearAuth();
	console.log("Logged out.");
}

export async function cmdWhoami(): Promise<void> {
	try {
		const user = (await api.auth.me()) as any;
		console.log(`username:        ${user.username}`);
		console.log(`Role:         ${user.role}`);
		console.log(`Plan:         ${user.subscription_tier}`);
		console.log(`Storage used: ${formatBytes(user.storage_used)}`);
		console.log(`Member since: ${user.created_at}`);
	} catch (err: any) {
		console.error(`Not logged in: ${err.message}`);
		process.exit(1);
	}
}

function formatBytes(b: number): string {
	if (b < 1024) return `${b} B`;
	if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
	if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
	return `${(b / 1024 ** 3).toFixed(2)} GB`;
}
