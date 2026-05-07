import * as fs from 'fs';
import * as path from 'path';

import { execFileSync } from 'child_process';

describe('scripts/check-config-adapters.ts (US-113)', () => {
  test('fails when an adapter lacks default export class', () => {
    const root = fs.mkdtempSync(path.join(__dirname, 'tmp-check-adapters-'));
    try {
      const configs = path.join(root, 'configs', 'acme', 'bad');
      fs.mkdirSync(configs, { recursive: true });
      fs.writeFileSync(path.join(configs, 'adapter.ts'), 'export const x = 1;\n', 'utf8');

      const script = path.join(__dirname, 'check-config-adapters.ts');

      // Run via ts-node in a subprocess with cwd=root.
      expect(() => {
        execFileSync(process.execPath, [
          path.join(root, 'node_modules', 'ts-node', 'dist', 'bin.js'),
          script,
        ], { cwd: root, stdio: 'pipe' });
      }).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
