const stubUrl = new URL('./vscode-stub.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: stubUrl, shortCircuit: true, format: 'module' };
  }
  return nextResolve(specifier, context);
}
