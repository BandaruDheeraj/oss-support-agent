/**
 * Manifest registry that scans `configs/<org>/<repo>/manifest.yaml` on disk.
 */

import * as fs from 'fs';
import * as path from 'path';

import { loadManifest } from '../../core/manifest/loader';
import type { Manifest } from '../../core/manifest/types';
import type { ManifestRegistry } from '../../core/webhook/router';

export class FsManifestRegistry implements ManifestRegistry {
  constructor(private readonly repoRoot: string) {}

  getManifest(repo: string): Manifest | null {
    const parts = repo.split('/');
    if (parts.length !== 2) return null;
    const [owner, name] = parts;

    const manifestPath = path.join(this.repoRoot, 'configs', owner, name, 'manifest.yaml');
    if (!fs.existsSync(manifestPath)) return null;
    try {
      return loadManifest(manifestPath);
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.warn(`[manifest] failed to load ${manifestPath}: ${err?.message ?? err}`);
      return null;
    }
  }
}
