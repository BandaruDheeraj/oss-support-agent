import * as fs from 'fs';
import * as path from 'path';

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const configsRoot = path.join(projectRoot, 'configs');
  if (!fs.existsSync(configsRoot)) return;

  const files = walk(configsRoot).filter((p) => p.endsWith(`${path.sep}adapter.ts`));
  const failures: Array<{ file: string; reason: string }> = [];

  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (!/\bexport\s+default\s+class\b/.test(text)) {
      failures.push({
        file: path.relative(projectRoot, f),
        reason: 'adapter must have a default class export: `export default class ...`',
      });
    }
  }

  if (failures.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Constraint violation: configs/**/adapter.ts must export a default class.');
    for (const x of failures) {
      // eslint-disable-next-line no-console
      console.error(`- ${x.file}: ${x.reason}`);
    }
    process.exitCode = 1;
  }
}

main();
