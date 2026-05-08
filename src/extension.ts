import * as vscode from 'vscode';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  context.subscriptions.push(output);
  output.appendLine('Ditto Edge Studio extension activated.');
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
