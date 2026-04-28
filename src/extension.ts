import * as vscode from 'vscode';
import { CreditWebviewProvider } from './creditWebviewProvider';

export function activate(context: vscode.ExtensionContext) {
  const provider = new CreditWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CreditWebviewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCredit.refresh', () => provider.refresh())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCredit.setCookie', async () => {
      const current = vscode.workspace
        .getConfiguration('claudeCredit')
        .get<string>('sessionCookie', '');

      const value = await vscode.window.showInputBox({
        title: 'Cookie de session Claude',
        prompt: 'Colle la valeur du cookie sessionKey (claude.ai → F12 → Application → Cookies)',
        value: current,
        password: true,
        placeHolder: 'sk-ant-...',
        ignoreFocusOut: true,
      });

      if (value !== undefined) {
        await vscode.workspace
          .getConfiguration('claudeCredit')
          .update('sessionCookie', value, vscode.ConfigurationTarget.Global);
        provider.refresh();
        vscode.window.showInformationMessage('Cookie enregistré !');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCredit.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'claudeCredit')
    )
  );
}

export function deactivate() {}
