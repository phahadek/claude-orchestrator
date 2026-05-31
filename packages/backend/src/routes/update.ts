import { Router } from 'express';
import type { Request, Response } from 'express';
import { UpdateChecker, downloadAsset, selectAsset, cleanUpdatesDir } from '../updater/index.js';
import { launchInstallerAndExit } from '../updater/UpdateInstaller.js';
import type { ServerMessage } from '../ws/types.js';

let _checker: UpdateChecker | null = null;
let _broadcast: ((msg: ServerMessage) => void) | null = null;

export function setUpdateChecker(
  checker: UpdateChecker,
  broadcast: (msg: ServerMessage) => void,
): void {
  _checker = checker;
  _broadcast = broadcast;
}

const router = Router();

/** POST /api/update/check — force an immediate check */
router.post('/update/check', async (_req: Request, res: Response) => {
  if (!_checker) {
    res.status(503).json({ error: 'updater not initialized' });
    return;
  }
  try {
    const info = await _checker.checkNow();
    res.json({ updateAvailable: info !== null, info: info ?? undefined });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

/** POST /api/update/dismiss — suppress banner for the given version */
router.post('/update/dismiss', (req: Request, res: Response) => {
  if (!_checker) {
    res.status(503).json({ error: 'updater not initialized' });
    return;
  }
  const { version } = req.body as { version?: string };
  if (!version) {
    res.status(400).json({ error: 'version required' });
    return;
  }
  _checker.dismiss(version);
  res.json({ ok: true });
});

/** POST /api/update/install — download asset and launch installer */
router.post('/update/install', async (req: Request, res: Response) => {
  const { version } = req.body as { version?: string };
  if (!version) {
    res.status(400).json({ error: 'version required' });
    return;
  }
  if (!_checker) {
    res.status(503).json({ error: 'updater not initialized' });
    return;
  }

  try {
    // Kick off fresh check to get asset list for the specified version
    const info = await _checker.checkNow();
    if (!info) {
      res.status(409).json({ error: 'no update available' });
      return;
    }

    const asset = selectAsset(info);
    if (!asset) {
      res.status(422).json({ error: 'no suitable installer asset found for this platform' });
      return;
    }

    // Respond immediately so client gets acknowledgement before we exit
    res.json({ ok: true, asset: asset.name });

    // Download and install asynchronously
    setImmediate(async () => {
      try {
        const installerPath = await downloadAsset(asset);
        launchInstallerAndExit(installerPath);
      } catch (err) {
        console.error('[updater] install failed:', (err as Error).message);
        // Clean up partial download
        cleanUpdatesDir();
        _broadcast?.({ type: 'error', message: `Update install failed: ${(err as Error).message}` });
      }
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as updateRouter };
