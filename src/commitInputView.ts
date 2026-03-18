import * as vscode from 'vscode';

/**
 * WebviewViewProvider that renders a commit message textarea in the sidebar,
 * similar to VS Code's native Source Control commit input box.
 *
 * The provider holds the current draft message so the commit command (invoked
 * from the view's title-bar button or from Ctrl+Enter inside the textarea) can
 * read it without going through a separate input popup.
 */
export class CommitInputViewProvider implements vscode.WebviewViewProvider {
    static readonly viewId = 'remoteGit.commitInput';

    private _view: vscode.WebviewView | undefined;
    private _currentMessage = '';
    private _remoteDescription: string | undefined;

    // ------------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------------

    /** The commit message text currently typed in the textarea. */
    get currentMessage(): string {
        return this._currentMessage;
    }

    /**
     * Update the remote destination label shown in the view's description
     * (the subdued text in the accordion header next to the title).
     */
    setRemoteDescription(description: string | undefined): void {
        this._remoteDescription = description;
        if (this._view) {
            this._view.description = description;
        }
    }

    /** Clear the textarea after a successful commit. */
    clearMessage(): void {
        this._currentMessage = '';
        this._view?.webview.postMessage({ type: 'clear' });
    }

    // ------------------------------------------------------------------
    // WebviewViewProvider
    // ------------------------------------------------------------------

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        this._view = webviewView;

        if (this._remoteDescription) {
            webviewView.description = this._remoteDescription;
        }

        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html  = this._html();

        webviewView.webview.onDidReceiveMessage(msg => {
            switch (msg.type) {
                case 'messageChange':
                    this._currentMessage = msg.message as string;
                    break;
                case 'commit':
                    this._currentMessage = msg.message as string;
                    vscode.commands.executeCommand('remoteGit.commit');
                    break;
            }
        });
    }

    // ------------------------------------------------------------------
    // HTML
    // ------------------------------------------------------------------

    private _html(): string {
        return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: transparent;
    padding: 6px 8px 8px;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }

  textarea {
    display: block;
    width: 100%;
    min-height: 54px;
    resize: vertical;
    font-family: inherit;
    font-size: inherit;
    line-height: 1.4;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    padding: 5px 8px;
    outline: none;
  }
  textarea:focus {
    border-color: var(--vscode-focusBorder);
  }
  textarea::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  button {
    margin-top: 6px;
    width: 100%;
    padding: 4px 10px;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 2px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button:hover {
    background: var(--vscode-button-hoverBackground);
  }
  button:active {
    opacity: 0.9;
  }
</style>
</head>
<body>
<textarea id="msg" placeholder="Message (⌃↵ to commit on remote)" rows="3" spellcheck="true"></textarea>
<button id="btn">Commit on Remote</button>

<script>
  const vscode = acquireVsCodeApi();
  const ta  = document.getElementById('msg');
  const btn = document.getElementById('btn');

  ta.addEventListener('input', () => {
    vscode.postMessage({ type: 'messageChange', message: ta.value });
  });

  ta.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      vscode.postMessage({ type: 'commit', message: ta.value });
    }
  });

  btn.addEventListener('click', () => {
    vscode.postMessage({ type: 'commit', message: ta.value });
  });

  window.addEventListener('message', ev => {
    const data = ev.data;
    if (data.type === 'clear') {
      ta.value = '';
      vscode.postMessage({ type: 'messageChange', message: '' });
    }
  });
</script>
</body>
</html>`;
    }
}
