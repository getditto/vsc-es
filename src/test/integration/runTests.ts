import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// esbuild targets CJS, so Node's built-in `__dirname` is available at runtime.
// Avoid `import.meta.url` here since esbuild can't resolve it for CJS output.
declare const __dirname: string;

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, '../../../');
    const extensionTestsPath = path.resolve(__dirname, './index.js');
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: ['--disable-extensions'],
      extensionTestsEnv: {
        DITTO_CI_MODE: process.env.DITTO_CI_MODE ?? '',
        DITTO_CI_DATABASE_ID: process.env.DITTO_CI_DATABASE_ID ?? '',
        DITTO_CI_DEVELOPMENT_TOKEN: process.env.DITTO_CI_DEVELOPMENT_TOKEN ?? '',
        DITTO_CI_URL: process.env.DITTO_CI_URL ?? '',
        DITTO_CI_SITE_NAME: process.env.DITTO_CI_SITE_NAME ?? '',
        DITTO_CI_DEPTH: process.env.DITTO_CI_DEPTH ?? 'load',
      },
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

void main();
