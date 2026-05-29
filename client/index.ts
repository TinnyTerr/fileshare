import { cmdLogin, cmdRegister, cmdLogout, cmdWhoami } from './commands/auth';
import { cmdUpload, cmdDownload, cmdList, cmdInfo, cmdDelete, cmdShare, cmdUnshare } from './commands/files';
import { cmdVersion, cmdCheckUpdate, cmdUpdate } from './commands/update';
import {
  cmdGroupCreate, cmdGroupList, cmdGroupInfo, cmdGroupInvite,
  cmdGroupJoin, cmdGroupLeave, cmdGroupDelete, cmdGroupAddMember, cmdGroupRemoveMemberById,
} from './commands/groups';
import { cmdCreateLink, cmdListLinks, cmdRevokeLink, cmdDownloadLink } from './commands/links';
import { loadConfig, saveConfig } from './config';

const HELP = `
fileshare — file sharing CLI  (AES-256-GCM encrypted storage)

Usage: fileshare <command> [options]

Auth:
  login [email] [password]          Log in
  register [email] [password]       Register
  logout                            Log out
  whoami                            Show current user

Files:
  upload <path> [--expires <days>]  Upload (100MB chunks)
  download <id> [--output <path>]   Download
  list [--page <n>]                 List your files
  info <id>                         File metadata, shares, links
  delete <id>                       Delete
  share <id> --user <email>         Share with user [--write]
  unshare <id> --user <email>       Revoke user access

Groups:
  group create <name>               Create a group
  group list                        List your groups
  group info <id>                   Members and details
  group add-member <id> --user <email> [--role admin|member]
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
  config show

Updates:
  version                           Show client version
  check-update                      Check for newer client
  update [--force]                  Self-update to latest release
`.trim();

async function main() {
  const args = process.argv.slice(2);
  const [cmd, sub, ...rest] = args;

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return;
  }

  // Silent update check on every run
  cmdCheckUpdate(true).catch(() => {});

  switch (cmd) {
    case 'login':        return cmdLogin([sub!, ...rest]);
    case 'register':     return cmdRegister([sub!, ...rest]);
    case 'logout':       return cmdLogout();
    case 'whoami':       return cmdWhoami();

    case 'upload':       return cmdUpload([sub!, ...rest]);
    case 'download':     return cmdDownload([sub!, ...rest]);
    case 'list':         return cmdList([sub!, ...rest]);
    case 'info':         return cmdInfo([sub!, ...rest]);
    case 'delete':       return cmdDelete([sub!, ...rest]);
    case 'share':        return cmdShare([sub!, ...rest]);
    case 'unshare':      return cmdUnshare([sub!, ...rest]);

    case 'group': {
      switch (sub) {
        case 'create':        return cmdGroupCreate(rest);
        case 'list':          return cmdGroupList();
        case 'info':          return cmdGroupInfo(rest);
        case 'add-member':    return cmdGroupAddMember(rest);
        case 'remove-member': return cmdGroupRemoveMemberById(rest);
        case 'invite':        return cmdGroupInvite(rest);
        case 'join':          return cmdGroupJoin(rest);
        case 'leave':         return cmdGroupLeave(rest);
        case 'delete':        return cmdGroupDelete(rest);
        default:
          console.error(`Unknown group command: ${sub}\nRun "fileshare --help" for usage.`);
          process.exit(1);
      }
    }

    case 'link': {
      switch (sub) {
        case 'create':   return cmdCreateLink(rest);
        case 'list':     return cmdListLinks(rest);
        case 'revoke':   return cmdRevokeLink(rest);
        case 'download': return cmdDownloadLink(rest);
        default:
          console.error(`Unknown link command: ${sub}\nRun "fileshare --help" for usage.`);
          process.exit(1);
      }
    }

    case 'version':      return cmdVersion();
    case 'check-update': return cmdCheckUpdate(false);
    case 'update':       return cmdUpdate([sub!, ...rest].filter(Boolean));

    case 'config': {
      if (sub === 'show') {
        const cfg = loadConfig();
        const safe = { ...cfg, access_token: cfg.access_token ? '***' : undefined, refresh_token: cfg.refresh_token ? '***' : undefined };
        console.log(JSON.stringify(safe, null, 2));
      } else if (sub === 'set' && rest[0] === 'server' && rest[1]) {
        saveConfig({ server: rest[1] });
        console.log(`Server set to: ${rest[1]}`);
      } else {
        console.error('Usage: fileshare config set server <url> | fileshare config show');
        process.exit(1);
      }
      return;
    }

    default:
      console.error(`Unknown command: ${cmd}\nRun "fileshare --help" for usage.`);
      process.exit(1);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
