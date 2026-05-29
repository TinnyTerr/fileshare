import { api, ApiError } from '../api';
import { loadConfig } from '../config';

export async function cmdCreateLink(args: string[]): Promise<void> {
  const fileId = args[0];
  if (!fileId) {
    console.error('Usage: fileshare link create <file-id> [--password <pw>] [--expires <days>] [--max-downloads <n>] [--write]');
    process.exit(1);
  }

  const pwIdx    = args.indexOf('--password');
  const expIdx   = args.indexOf('--expires');
  const maxIdx   = args.indexOf('--max-downloads');

  const password      = pwIdx  >= 0 ? args[pwIdx  + 1]  : undefined;
  const expiresDays   = expIdx >= 0 ? parseInt(args[expIdx + 1]!) : undefined;
  const maxDownloads  = maxIdx >= 0 ? parseInt(args[maxIdx + 1]!) : undefined;
  const canWrite      = args.includes('--write');

  try {
    const result = await api.links.create(fileId, { password, expires_days: expiresDays, max_downloads: maxDownloads, can_write: canWrite }) as any;
    console.log(`✓ Share link: ${result.url}`);
    if (result.password_protected) console.log(`  Password protected (E2E — server cannot decrypt without password)`);
    if (result.expires_at)         console.log(`  Expires: ${result.expires_at}`);
    if (result.max_downloads)      console.log(`  Max downloads: ${result.max_downloads}`);
  } catch (err: any) {
    console.error(`Failed: ${err.message}`); process.exit(1);
  }
}

export async function cmdListLinks(args: string[]): Promise<void> {
  const fileId = args[0];
  if (!fileId) { console.error('Usage: fileshare link list <file-id>'); process.exit(1); }

  try {
    const { links } = await api.links.list(fileId) as any;
    if (!links.length) { console.log('No active share links.'); return; }
    console.log(`\nShare links for ${fileId}:`);
    console.log('─'.repeat(70));
    for (const l of links) {
      const pw   = l.password_protected ? '[pw]' : '    ';
      const dl   = l.max_downloads ? `${l.downloads}/${l.max_downloads} dl` : `${l.downloads} dl`;
      const exp  = l.expires_at ? `exp ${l.expires_at.slice(0, 10)}` : 'no expiry';
      console.log(`  ${l.id}  ${pw}  ${dl.padEnd(12)} ${exp}`);
    }
  } catch (err: any) {
    console.error(`Failed: ${err.message}`); process.exit(1);
  }
}

export async function cmdRevokeLink(args: string[]): Promise<void> {
  const fileId = args[0];
  const linkId = args[1];
  if (!fileId || !linkId) {
    console.error('Usage: fileshare link revoke <file-id> <link-id>');
    process.exit(1);
  }
  try {
    await api.links.revoke(fileId, linkId);
    console.log(`✓ Link ${linkId} revoked`);
  } catch (err: any) {
    console.error(`Failed: ${err.message}`); process.exit(1);
  }
}

export async function cmdDownloadLink(args: string[]): Promise<void> {
  const token  = args[0];
  const outIdx = args.indexOf('--output');

  if (!token) { console.error('Usage: fileshare link download <token> [--password <pw>] [--output <path>]'); process.exit(1); }

  const cfg = loadConfig();

  // Get file info first
  let info: any;
  try {
    const res = await fetch(`${cfg.server}/api/dl/${token}`);
    info = await res.json();
  } catch (err: any) {
    console.error(`Failed to fetch link info: ${err.message}`); process.exit(1);
  }

  if (info.error) { console.error(`Link error: ${info.error}`); process.exit(1); }

  let password: string | undefined;
  if (info.password_required) {
    const pwIdx = args.indexOf('--password');
    if (pwIdx >= 0) {
      password = args[pwIdx + 1];
    } else {
      const { createInterface } = await import('readline');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      password = await new Promise(resolve => rl.question('Password: ', pw => { rl.close(); resolve(pw); }));
    }
  }

  const destPath = outIdx >= 0 ? args[outIdx + 1]! : info.filename;

  console.log(`Downloading: ${info.filename} (${formatBytes(info.size)})`);

  const { CHUNK_SIZE } = await import('../../shared/types');
  const headers: Record<string, string> = {};
  if (password) headers['X-Share-Password'] = password;

  const writer = Bun.file(destPath!).writer();
  let offset = 0;

  while (offset < info.size) {
    const end = Math.min(offset + CHUNK_SIZE - 1, info.size - 1);
    const rangeHeaders = { ...headers, Range: `bytes=${offset}-${end}` };

    const res = await fetch(`${cfg.server}/api/dl/${token}/data`, { headers: rangeHeaders });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText })) as any;
      console.error(`\nDownload failed: ${err.error || res.statusText}`);
      process.exit(1);
    }

    const data = await res.arrayBuffer();
    writer.write(data);
    offset += data.byteLength;
    process.stdout.write(`\r[${progressBar(Math.round(offset / info.size * 100))}] ${formatBytes(offset)}`);
  }

  await writer.end();
  process.stdout.write('\r\x1b[K');
  console.log(`✓ Saved to: ${destPath}`);
}

function formatBytes(b: number): string {
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function progressBar(pct: number): string {
  const filled = Math.floor(pct / 5);
  return `${'█'.repeat(filled)}${' '.repeat(20 - filled)}] ${pct}%`;
}
