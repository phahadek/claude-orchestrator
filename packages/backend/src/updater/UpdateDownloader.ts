import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { GitHubAsset, UpdateInfo } from './types.js';
import { getDataDir } from '../config/dataDir.js';

const execFileAsync = promisify(execFile);

export function selectAsset(info: UpdateInfo): GitHubAsset | null {
  const platform = process.platform;
  const arch = process.arch;

  for (const asset of info.assets) {
    const name = asset.name.toLowerCase();

    if (platform === 'win32') {
      if (name.endsWith('.exe') && (name.includes('setup') || name.includes('installer') || name.includes('win'))) {
        return asset;
      }
    } else if (platform === 'darwin') {
      if (name.endsWith('.dmg') || (name.endsWith('.pkg') && name.includes('mac'))) {
        if (arch === 'arm64' && (name.includes('arm64') || name.includes('apple-silicon'))) return asset;
        if (arch === 'x64' && !name.includes('arm64')) return asset;
        // fallback: any dmg
        return asset;
      }
    } else {
      // Linux
      if (name.endsWith('.deb') || name.endsWith('.rpm') || name.endsWith('.AppImage')) {
        if (arch === 'arm64' && name.includes('arm64')) return asset;
        if (arch === 'x64' && (name.includes('amd64') || name.includes('x86_64') || name.includes('x64'))) return asset;
      }
    }
  }

  // Fallback: return the first asset that looks like an installer
  return info.assets.find((a) => {
    const n = a.name.toLowerCase();
    return n.endsWith('.exe') || n.endsWith('.dmg') || n.endsWith('.deb') || n.endsWith('.AppImage');
  }) ?? null;
}

export function getUpdatesDir(): string {
  return path.join(getDataDir(), 'updates');
}

function downloadFile(url: string, destPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);

    function makeRequest(requestUrl: string): void {
      const mod = requestUrl.startsWith('https') ? https : http;
      const req = mod.get(
        requestUrl,
        { headers: { 'User-Agent': 'claude-orchestrator-updater' } },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const redirectUrl = res.headers.location;
            if (redirectUrl) {
              makeRequest(redirectUrl);
              return;
            }
          }
          if (res.statusCode !== 200) {
            file.destroy();
            reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}`));
            return;
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', reject);
        },
      );
      req.on('error', (err) => {
        file.destroy();
        reject(err);
      });
      req.setTimeout(120_000, () => {
        req.destroy();
        file.destroy();
        reject(new Error('Download timed out'));
      });
    }

    makeRequest(url);
  });
}

export async function downloadAsset(
  asset: GitHubAsset,
  onProgress?: (downloaded: number, total: number) => void,
): Promise<string> {
  const updatesDir = getUpdatesDir();
  fs.mkdirSync(updatesDir, { recursive: true });

  const destPath = path.join(updatesDir, asset.name);

  // Clean up partial download if it exists
  if (fs.existsSync(destPath)) {
    fs.unlinkSync(destPath);
  }

  await downloadFile(asset.browser_download_url, destPath);

  // Verify file size
  const stat = fs.statSync(destPath);
  if (stat.size !== asset.size) {
    fs.unlinkSync(destPath);
    throw new Error(
      `Size mismatch: expected ${asset.size}, got ${stat.size}`,
    );
  }

  if (onProgress) onProgress(asset.size, asset.size);

  // On Linux, verify GPG signature if a .sig or .asc file exists alongside
  if (process.platform === 'linux') {
    const sigAsset = asset.name + '.sig';
    // If there's a corresponding .sig asset, download and verify
    // (best-effort — don't fail if GPG is unavailable)
    try {
      await verifyGpgSignature(destPath, asset, sigAsset);
    } catch (err) {
      console.warn('[updater] GPG verification skipped:', (err as Error).message);
    }
  }

  return destPath;
}

async function verifyGpgSignature(
  filePath: string,
  asset: GitHubAsset,
  sigAssetName: string,
): Promise<void> {
  // Check if gpg is available
  try {
    await execFileAsync('gpg', ['--version']);
  } catch {
    return; // gpg not available — skip
  }

  const sigPath = filePath + '.sig';
  const updatesDir = getUpdatesDir();
  const sigUrl = asset.browser_download_url.replace(
    encodeURIComponent(asset.name),
    encodeURIComponent(sigAssetName),
  ).replace(asset.name, sigAssetName);

  try {
    await downloadFile(sigUrl, sigPath);
    await execFileAsync('gpg', ['--verify', sigPath, filePath]);
    console.log('[updater] GPG signature verified');
  } catch (err) {
    if (fs.existsSync(sigPath)) fs.unlinkSync(sigPath);
    // Not a hard failure — sig file may not exist for all releases
    console.warn('[updater] GPG signature not verified:', (err as Error).message);
  }
}

/** Clean up the updates directory on startup (remove leftover files). */
export function cleanUpdatesDir(): void {
  const updatesDir = getUpdatesDir();
  if (!fs.existsSync(updatesDir)) return;
  try {
    const files = fs.readdirSync(updatesDir);
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(updatesDir, f));
      } catch {
        // best effort
      }
    }
  } catch {
    // best effort
  }
}
