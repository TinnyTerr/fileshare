import { cmdLogin, cmdLogout, cmdRegister, cmdWhoami } from "./commands/auth";
import {
	cmdDelete,
	cmdDownload,
	cmdInfo,
	cmdList,
	cmdShare,
	cmdUnshare,
	cmdUpload,
} from "./commands/files";
import {
	cmdGroupAddMember,
	cmdGroupCreate,
	cmdGroupDelete,
	cmdGroupInfo,
	cmdGroupInvite,
	cmdGroupJoin,
	cmdGroupLeave,
	cmdGroupList,
	cmdGroupRemoveMemberById,
} from "./commands/groups";
import {
	cmdCreateLink,
	cmdDownloadLink,
	cmdListLinks,
	cmdRevokeLink,
} from "./commands/links";
import { cmdCheckUpdate, cmdUpdate, cmdVersion } from "./commands/update";
import { flushClientLogs, setVerbose } from "./api";
import { loadConfig, saveConfig } from "./config";

const HELP = `
fileshare — file sharing CLI  (AES-256-GCM encrypted storage)

Usage: fileshare [--verbose] <command> [options]

  --verbose    Print request/response details and upload chunk progress.
               Persist with: fileshare config set verbose on

Auth:
  login [username] [password]          Log in
  register [username] [password]       Register
  logout                            Log out
  whoami                            Show current user

Files:
  upload <path> [--expires <days>]  Upload (100MB chunks)
  download <id> [--output <path>]   Download
  list [--page <n>]                 List your files
  info <id>                         File metadata, shares, links
  delete <id>                       Delete
  share <id> --user <username>         Share with user [--write]
  unshare <id> --user <username>       Revoke user access

Groups:
  group create <name>               Create a group
  group list                        List your groups
  group info <id>                   Members and details
  group add-member <id> --user <username> [--role admin|member]
  group remove-member <id> --user-id <uid>
  group invite <id> [--password <pw>] [--expires <days>] [--max-uses <n>]
  group join <token> [--password <pw>]
  group leave <id>
  group delete <id>

Share links  (no login required to download):
  link create <file-id> [--password <pw>] [--expires <days>]
              [--max-downloads <n>] [--write]
  link list <file-id>               List active links
  link revoke <file-id> <link-id>   Revoke a link
  link download <token> [--password <pw>] [--output <path>]

Config:
  config set server <url>
  config set verbose on|off         Persist verbose mode
  config show

Updates:
  version                           Show client version
  check-update                      Check for newer client
  update [--force]                  Self-update to latest release
`.trim();

// Intercept process.exit so we can flush logs before terminating.
const _realExit = process.exit.bind(process);
(process as any).exit = (code?: number) => {
	Promise.race([
		flushClientLogs(),
		new Promise<void>((resolve) => setTimeout(resolve, 3000)),
	])
		.catch(() => {})
		.finally(() => _realExit(code));
};

async function main() {
	const rawArgs = process.argv.slice(2);

	// Strip --verbose before positional parsing so it can appear anywhere.
	const verbose = rawArgs.includes("--verbose");
	const args = rawArgs.filter((a) => a !== "--verbose");

	if (verbose) setVerbose(true);

	const [cmd, sub, ...rest] = args;

	if (!cmd || cmd === "--help" || cmd === "-h") {
		console.log(HELP);
		return;
	}

	// Silent update check on every run (skip when the command already handles updates)
	if (cmd !== "check-update" && cmd !== "update") {
		cmdCheckUpdate(true).catch(() => {});
	}

	switch (cmd) {
		case "login":
			return cmdLogin([sub!, ...rest]);
		case "register":
			return cmdRegister([sub!, ...rest]);
		case "logout":
			return cmdLogout();
		case "whoami":
			return cmdWhoami();

		case "upload":
			return cmdUpload([sub!, ...rest]);
		case "download":
			return cmdDownload([sub!, ...rest]);
		case "list":
			return cmdList([sub!, ...rest]);
		case "info":
			return cmdInfo([sub!, ...rest]);
		case "delete":
			return cmdDelete([sub!, ...rest]);
		case "share":
			return cmdShare([sub!, ...rest]);
		case "unshare":
			return cmdUnshare([sub!, ...rest]);

		case "group": {
			switch (sub) {
				case "create":
					return cmdGroupCreate(rest);
				case "list":
					return cmdGroupList();
				case "info":
					return cmdGroupInfo(rest);
				case "add-member":
					return cmdGroupAddMember(rest);
				case "remove-member":
					return cmdGroupRemoveMemberById(rest);
				case "invite":
					return cmdGroupInvite(rest);
				case "join":
					return cmdGroupJoin(rest);
				case "leave":
					return cmdGroupLeave(rest);
				case "delete":
					return cmdGroupDelete(rest);
				default:
					console.error(
						`Unknown group command: ${sub}\nRun "fileshare --help" for usage.`,
					);
					process.exit(1);
			}
		}

		case "link": {
			switch (sub) {
				case "create":
					return cmdCreateLink(rest);
				case "list":
					return cmdListLinks(rest);
				case "revoke":
					return cmdRevokeLink(rest);
				case "download":
					return cmdDownloadLink(rest);
				default:
					console.error(
						`Unknown link command: ${sub}\nRun "fileshare --help" for usage.`,
					);
					process.exit(1);
			}
		}

		case "version":
			return cmdVersion();
		case "check-update":
			return cmdCheckUpdate(false);
		case "update":
			return cmdUpdate([sub!, ...rest].filter(Boolean));

		case "config": {
			if (sub === "show") {
				const cfg = loadConfig();
				const safe = {
					...cfg,
					access_token: cfg.access_token ? "***" : undefined,
					refresh_token: cfg.refresh_token ? "***" : undefined,
				};
				console.log(JSON.stringify(safe, null, 2));
			} else if (sub === "set" && rest[0] === "server" && rest[1]) {
				saveConfig({ server: rest[1] });
				console.log(`Server set to: ${rest[1]}`);
			} else if (sub === "set" && rest[0] === "verbose") {
				const on = rest[1] === "on" || rest[1] === "true" || rest[1] === "1";
				const off = rest[1] === "off" || rest[1] === "false" || rest[1] === "0";
				if (!on && !off) {
					console.error("Usage: fileshare config set verbose on|off");
					process.exit(1);
				}
				saveConfig({ verbose: on });
				console.log(`Verbose mode: ${on ? "on" : "off"}`);
			} else {
				console.error(
					"Usage: fileshare config set server <url> | fileshare config set verbose on|off | fileshare config show",
				);
				process.exit(1);
			}
			return;
		}

		default:
			console.error(
				`Unknown command: ${cmd}\nRun "fileshare --help" for usage.`,
			);
			process.exit(1);
	}
}

main()
	.then(() => flushClientLogs().catch(() => {}))
	.catch(async (err) => {
		console.error(err.message);
		await flushClientLogs().catch(() => {});
		_realExit(1);
	});
