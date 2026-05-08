import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { config as loadDotenv } from 'dotenv';
import { Ditto, DittoConfig, Authenticator } from '@dittolive/ditto';

let output: vscode.OutputChannel;
let ditto: Ditto | undefined;

export async function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);
  output.appendLine('Ditto Edge Studio extension activated.');
  output.show(true);

  loadDotenv({ path: path.join(context.extensionPath, '.env') });

  const appId = process.env.DITTO_APP_ID;
  const token = process.env.DITTO_PLAYGROUND_TOKEN;
  const authUrl = process.env.DITTO_AUTH_URL;

  if (!appId || !token || !authUrl) {
    output.appendLine('SPIKE: missing env vars; skipping Ditto smoke test.');
    return;
  }

  try {
    output.appendLine('SPIKE: opening Ditto…');

    const persistenceDir = path.join(context.globalStorageUri.fsPath, 'spike');
    fs.mkdirSync(persistenceDir, { recursive: true });

    const config = new DittoConfig(appId, { mode: 'server', url: authUrl }, persistenceDir);
    ditto = await Ditto.open(config);

    ditto.updateTransportConfig((c: any) => {
      c.peerToPeer.bluetoothLE.isEnabled = false;
      c.peerToPeer.awdl.isEnabled = false;
      c.peerToPeer.lan.isEnabled = true;
      c.peerToPeer.lan.isMdnsEnabled = true;
      c.peerToPeer.lan.isMulticastEnabled = true;
    });

    if (ditto.auth.loginSupported) {
      await ditto.auth.setExpirationHandler(async (instance: any) => {
        if (instance.auth.loginSupported) {
          await instance.auth.login(token, Authenticator.DEVELOPMENT_PROVIDER);
        }
      });
      const result = await ditto.auth.login(token, Authenticator.DEVELOPMENT_PROVIDER);
      if (result.error) {
        output.appendLine(`SPIKE: login failed: ${result.error}`);
        return;
      }
      output.appendLine('SPIKE: login OK');
    }

    ditto.sync.start();
    output.appendLine('SPIKE: sync started');

    const observer = ditto.store.registerObserver(
      'SELECT * FROM vsce_smoke',
      (result: any) => {
        const items = result.items.map((i: any) => i.value);
        output.appendLine(`SPIKE: observer saw ${items.length} doc(s): ${JSON.stringify(items)}`);
      }
    );
    context.subscriptions.push({ dispose: () => observer.cancel() });

    const sub = ditto.sync.registerSubscription('SELECT * FROM vsce_smoke');
    context.subscriptions.push({ dispose: () => sub.cancel() });

    await ditto.store.execute('INSERT INTO vsce_smoke DOCUMENTS (:doc)', {
      doc: { hello: 'world', t: Date.now() }
    });
    output.appendLine('SPIKE: inserted doc into vsce_smoke');
  } catch (err) {
    output.appendLine(`SPIKE: failed: ${err instanceof Error ? err.stack : String(err)}`);
  }
}

export async function deactivate() {
  if (ditto) {
    try {
      ditto.sync.stop();
      await ditto.close();
    } catch { /* ignore */ }
    ditto = undefined;
  }
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
