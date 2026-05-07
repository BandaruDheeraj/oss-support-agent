import path from 'node:path';
import ts from 'typescript';

type Violation = {
  sourceFile: string;
  specifier: string;
  resolved: string;
};

function loadTsConfig(projectRoot: string) {
  const tsconfigPath = path.join(projectRoot, 'tsconfig.json');
  const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (read.error) {
    const msg = ts.flattenDiagnosticMessageText(read.error.messageText, '\n');
    throw new Error(`Failed to read tsconfig.json: ${msg}`);
  }

  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    projectRoot,
    undefined,
    tsconfigPath
  );

  if (parsed.errors.length > 0) {
    const msg = parsed.errors
      .map((e) => ts.flattenDiagnosticMessageText(e.messageText, '\n'))
      .join('\n');
    throw new Error(`Failed to parse tsconfig.json:\n${msg}`);
  }

  return parsed;
}

function main() {
  const projectRoot = path.resolve(__dirname, '..');
  const parsed = loadTsConfig(projectRoot);

  const host: ts.ModuleResolutionHost = {
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    directoryExists: ts.sys.directoryExists,
    getCurrentDirectory: () => projectRoot,
    getDirectories: ts.sys.getDirectories,
    realpath: ts.sys.realpath,
  };

  const program = ts.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
  });

  const violations: Violation[] = [];
  const configsSegment = `${path.sep}configs${path.sep}`.toLowerCase();
  const coreSegment = `${path.sep}core${path.sep}`.toLowerCase();

  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const file = sf.fileName;
    const lower = file.toLowerCase();
    if (!lower.includes(coreSegment)) continue;

    sf.forEachChild((node) => {
      if (!ts.isImportDeclaration(node)) return;
      if (!ts.isStringLiteral(node.moduleSpecifier)) return;

      const spec = node.moduleSpecifier.text;
      const resolved = ts.resolveModuleName(
        spec,
        sf.fileName,
        parsed.options,
        host
      ).resolvedModule?.resolvedFileName;

      if (!resolved) return;
      if (resolved.toLowerCase().includes(configsSegment)) {
        violations.push({
          sourceFile: path.relative(projectRoot, sf.fileName),
          specifier: spec,
          resolved: path.relative(projectRoot, resolved),
        });
      }
    });
  }

  if (violations.length > 0) {
    // eslint-disable-next-line no-console
    console.error('Constraint violation: files under core/ must not import from configs/.');
    for (const v of violations) {
      // eslint-disable-next-line no-console
      console.error(`- ${v.sourceFile} imports "${v.specifier}" -> ${v.resolved}`);
    }
    process.exitCode = 1;
    return;
  }
}

main();
