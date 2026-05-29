import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CONFIG_DIR = join(homedir(), ".config", "fileshare");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export interface Config {
	server: string;
	access_token?: string;
	refresh_token?: string;
	username?: string;
	client_version: string;
}

const DEFAULTS: Config = {
	server: process.env.BAKED_SERVER || "http://localhost:3000",
	client_version: process.env.BAKED_VERSION || "0.0.0",
};

let _config: Config | null = null;

export function loadConfig(): Config {
	if (_config) return _config;
	if (!existsSync(CONFIG_FILE)) {
		_config = { ...DEFAULTS };
		return _config;
	}
	try {
		_config = {
			...DEFAULTS,
			...JSON.parse(require("fs").readFileSync(CONFIG_FILE, "utf-8")),
		};
	} catch {
		_config = { ...DEFAULTS };
	}
	return _config!;
}

export function saveConfig(updates: Partial<Config>): void {
	const cfg = loadConfig();
	_config = { ...cfg, ...updates };
	mkdirSync(CONFIG_DIR, { recursive: true });
	require("fs").writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2));
}

export function clearAuth(): void {
	saveConfig({
		access_token: undefined,
		refresh_token: undefined,
		username: undefined,
	});
}
