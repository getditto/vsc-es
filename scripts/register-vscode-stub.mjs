// Uses the synchronous hook API (Node 22.16+) so we run on the same
// plane as tsx's `registerHooks` and can short-circuit `'vscode'` imports
// before tsx's resolver hands off to Node's default (which can't find it).
import { registerHooks } from 'node:module';

const stubUrl = new URL('./vscode-stub.mjs', import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'vscode') {
      return { url: stubUrl, shortCircuit: true, format: 'module' };
    }
    return nextResolve(specifier, context);
  },
});
