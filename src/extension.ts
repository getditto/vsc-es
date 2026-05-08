import * as vscode from 'vscode';

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  output = vscode.window.createOutputChannel('Ditto Edge Studio');
  output.appendLine('Ditto Edge Studio extension activated.');
  context.subscriptions.push(output);
}

export function deactivate() {
  output?.appendLine('Ditto Edge Studio extension deactivated.');
}
