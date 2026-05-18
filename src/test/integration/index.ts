import * as path from 'path';
import Mocha from 'mocha';
import { glob } from 'glob';

// esbuild targets CJS, so Node's built-in `__dirname` is available at runtime.
// Avoid `import.meta.url` here since esbuild can't resolve it for CJS output.
declare const __dirname: string;

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 60_000 });
  const testsRoot = __dirname;
  const depth = process.env.DITTO_CI_DEPTH ?? 'load';
  const pattern = depth === 'e2e' ? '**/*.test.js' : 'activation.test.js';
  const files = await glob(pattern, { cwd: testsRoot });
  files.forEach(f => mocha.addFile(path.resolve(testsRoot, f)));
  return new Promise((resolve, reject) => {
    mocha.run(failures => failures > 0 ? reject(new Error(`${failures} failed`)) : resolve());
  });
}
