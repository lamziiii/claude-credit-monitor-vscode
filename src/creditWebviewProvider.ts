import * as vscode from 'vscode';
import { execFile } from 'child_process';

export interface BucketData {
  utilization: number;   // 0-100
  resetsAt?: string;     // ISO timestamp
  resetMinutes?: number;
  label: string;         // "5h" | "1h" | "7j"
}

export interface UsageData {
  email?: string;
  planName?: string;
  billingType?: string;
  memberSince?: string;
  // Bucket usage (source principale)
  bucket?: BucketData;
  allBuckets?: Record<string, BucketData>;
  // Debug
  rawOrgs?: unknown;
  rawExtra?: unknown;
}

export class CreditWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCredit.panel';

  private _view?: vscode.WebviewView;
  private _refreshTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = this._buildHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.command === 'refresh') { this.refresh(); }
      if (msg.command === 'openSettings') {
        vscode.commands.executeCommand('claudeCredit.setCookie');
      }
    });

    this.refresh();
    this._setupAutoRefresh();

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeCredit')) {
        this._setupAutoRefresh();
        this.refresh();
      }
    });
  }

  private _setupAutoRefresh() {
    if (this._refreshTimer) { clearInterval(this._refreshTimer); }
    const secs = vscode.workspace
      .getConfiguration('claudeCredit')
      .get<number>('refreshInterval', 30);
    const interval = Math.max(5, secs) * 1000;
    this._refreshTimer = setInterval(() => this.refresh(), interval);
  }

  public async refresh() {
    if (!this._view) { return; }

    const cookie = vscode.workspace
      .getConfiguration('claudeCredit')
      .get<string>('sessionCookie', '');

    if (!cookie.trim()) {
      this._view.webview.postMessage({ type: 'no_cookie' });
      return;
    }

    this._view.webview.postMessage({ type: 'loading' });

    try {
      const data = await this._fetchAll(cookie.trim());
      this._view.webview.postMessage({ type: 'data', data });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Erreur réseau';
      this._view.webview.postMessage({ type: 'error', message: msg });
    }
  }

  // ─── API fetching ────────────────────────────────────────────────────────────

  private async _fetchAll(sessionKey: string): Promise<UsageData> {
    // 1. Orgs + bootstrap en parallèle
    const [orgsResp, bootResp] = await Promise.all([
      this._get('https://claude.ai/api/organizations', sessionKey),
      this._get('https://claude.ai/api/bootstrap', sessionKey),
    ]);

    if (orgsResp.status === 401 || orgsResp.status === 403) {
      throw new Error('invalid_cookie');
    }

    if (orgsResp.status === 0 || orgsResp.status >= 500) {
      throw new Error(`Erreur serveur (HTTP ${orgsResp.status})`);
    }

    const orgs = orgsResp.data as Record<string, unknown>[];
    if (!Array.isArray(orgs)) {
      // Retourner la réponse brute pour diagnostiquer
      throw new Error(`Réponse inattendue (HTTP ${orgsResp.status}): ${JSON.stringify(orgsResp.data).slice(0, 100)}`);
    }
    if (orgs.length === 0) {
      throw new Error('Aucune organisation trouvée');
    }

    const org = orgs[0];
    const orgUuid = org['uuid'] as string;
    const result: UsageData = { rawOrgs: orgsResp.data };

    // ── Plan depuis capabilities ──────────────────────────────────────────────
    const caps = (org['capabilities'] as string[] | undefined) ?? [];
    if (caps.includes('claude_pro'))       { result.planName = 'Claude Pro'; }
    else if (caps.includes('claude_team')) { result.planName = 'Claude Team'; }
    else if (caps.includes('claude_free')) { result.planName = 'Free'; }
    else                                   { result.planName = caps[0] ?? 'Inconnu'; }

    // ── Billing type ──────────────────────────────────────────────────────────
    const bt = org['billing_type'] as string | undefined;
    if (bt === 'stripe_subscription')   { result.billingType = 'Abonnement'; }
    else if (bt === 'apple_subscription') { result.billingType = 'Apple'; }
    else if (bt)                          { result.billingType = bt; }

    // ── Date d'inscription ────────────────────────────────────────────────────
    const created = org['created_at'] as string | undefined;
    if (created) { result.memberSince = created.slice(0, 10); }

    // ── Email depuis bootstrap (source la plus fiable) ───────────────────────
    if (bootResp.status === 200) {
      const boot = bootResp.data as Record<string, unknown>;
      const acct = boot['account'] as Record<string, unknown> | undefined;
      if (acct) {
        result.email = (acct['email_address'] as string) ?? (acct['email'] as string);
      }
    } else {
      // Fallback: extraire depuis le nom de l'org
      const orgName = (org['name'] as string | undefined) ?? '';
      const m = orgName.match(/^(.+)'s Organization$/);
      if (m) { result.email = m[1]; }
    }

    // 2. Endpoint usage → buckets utilization (source principale des données)
    const usageResp = await this._get(
      `https://claude.ai/api/organizations/${orgUuid}/usage`, sessionKey
    );

    const extra: Record<string, unknown> = {
      bootstrap_status: bootResp.status,
      usage_status: usageResp.status,
    };

    if (usageResp.status === 200) {
      const raw = usageResp.data as Record<string, unknown>;
      extra['usage'] = raw;

      const BUCKET_PRIORITY = [
        ['five_hour',        '5h'],
        ['one_hour',         '1h'],
        ['seven_day_omelette','7j'],
        ['seven_day',        '7j'],
      ] as const;

      const allBuckets: Record<string, BucketData> = {};

      for (const [key, label] of BUCKET_PRIORITY) {
        const b = raw[key] as Record<string, unknown> | undefined;
        if (b && typeof b['utilization'] === 'number') {
          const bd: BucketData = {
            utilization: b['utilization'] as number,
            label,
          };
          if (b['resets_at']) {
            bd.resetsAt = b['resets_at'] as string;
            bd.resetMinutes = this._minutesUntil(bd.resetsAt);
          }
          allBuckets[key] = bd;
          // Premier bucket trouvé = bucket principal
          if (!result.bucket) { result.bucket = bd; }
        }
      }

      if (Object.keys(allBuckets).length > 0) {
        result.allBuckets = allBuckets;
      }
    }

    result.rawExtra = extra;
    return result;
  }

  private _minutesUntil(isoStr: string): number {
    try {
      const target = new Date(isoStr).getTime();
      const now = Date.now();
      return Math.max(0, Math.round((target - now) / 60000));
    } catch { return 0; }
  }

  private _get(url: string, sessionKey: string): Promise<{ status: number; data: unknown }> {
    return new Promise((resolve, reject) => {
      const MARKER = '__HTTP_STATUS__';
      const args = [
        '-s',
        '--max-time', '15',
        '--compressed',
        '-H', `Cookie: sessionKey=${sessionKey}`,
        '-H', 'Accept: application/json, text/html, */*',
        '-H', 'Accept-Language: fr-FR,fr;q=0.9,en;q=0.8',
        '-H', 'Referer: https://claude.ai/',
        '-H', 'Origin: https://claude.ai',
        '-H', 'anthropic-client-sha: unknown',
        '-H', 'anthropic-client-version: unknown',
        '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        '-w', `\n${MARKER}%{http_code}`,
        url,
      ];

      execFile('curl', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) {
          reject(new Error(`curl introuvable ou erreur réseau: ${err.message}`));
          return;
        }
        const idx = stdout.lastIndexOf(`\n${MARKER}`);
        const body   = idx !== -1 ? stdout.slice(0, idx) : stdout;
        const status = idx !== -1 ? parseInt(stdout.slice(idx + MARKER.length + 1), 10) : 0;
        try {
          resolve({ status, data: JSON.parse(body) });
        } catch {
          resolve({ status, data: body });
        }
      });
    });
  }

  // ─── HTML ────────────────────────────────────────────────────────────────────

  private _buildHtml(webview: vscode.Webview): string {
    const nonce = this._nonce();

    return /* html */ `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             style-src 'nonce-${nonce}';
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      height: fit-content;
    }
    body {
      font-family: var(--vscode-font-family);
      font-size: 11px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      padding: 8px 8px 0 8px;
    }

    .state { display: none; }
    .state.active { display: block; }

    /* ── Setup / Erreur ── */
    .center { text-align: center; padding: 14px 0; }
    .muted { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.6; }
    .err-box {
      border: 1px solid rgba(239,68,68,0.4);
      background: rgba(239,68,68,0.08);
      border-radius: 5px;
      padding: 8px;
      text-align: center;
    }

    /* ── Premier chargement (spinner) ── */
    .spinner {
      display: block; margin: 16px auto 6px;
      width: 16px; height: 16px;
      border: 2px solid rgba(255,255,255,0.1);
      border-top-color: var(--vscode-button-background);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ── Données ── */
    .pct-value {
      font-size: 28px;
      font-weight: 700;
      line-height: 1;
      margin: 6px 0 5px;
      text-align: center;
    }
    .pct-value.low    { color: #10b981; }
    .pct-value.medium { color: #f59e0b; }
    .pct-value.high   { color: #ef4444; }

    .bar-bg {
      height: 5px;
      background: rgba(255,255,255,0.08);
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 5px;
      position: relative;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.5s ease;
    }

    /* Shimmer sur la barre pendant le refresh */
    .bar-fill.refreshing::after {
      content: '';
      position: absolute;
      top: 0; left: -60%; width: 60%; height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.25), transparent);
      animation: shimmer 1s ease-in-out infinite;
    }
    @keyframes shimmer { to { left: 110%; } }

    .reset {
      text-align: center;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      padding-bottom: 8px;
    }

    /* ── Bouton ── */
    button {
      font-family: var(--vscode-font-family);
      font-size: 11px;
      cursor: pointer;
      border: none;
      border-radius: 3px;
      padding: 4px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      margin-top: 6px;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .btn-ghost {
      background: transparent;
      color: var(--vscode-descriptionForeground);
      border: 1px solid rgba(255,255,255,0.1);
      margin-left: 4px;
    }
    .btn-ghost:hover { background: rgba(255,255,255,0.05); }
  </style>
</head>
<body>

  <!-- PREMIER CHARGEMENT -->
  <div id="s-loading" class="state active center">
    <span class="spinner"></span>
    <p class="muted">Chargement…</p>
  </div>

  <!-- NO COOKIE -->
  <div id="s-setup" class="state center">
    <p class="muted">
      <strong style="color:var(--vscode-foreground)">Cookie requis</strong><br><br>
      1. Ouvre <strong>claude.ai</strong><br>
      2. F12 → Application → Cookies<br>
      3. Copie la valeur de <code>sessionKey</code>
    </p>
    <button id="btn-cookie">Coller le cookie</button>
  </div>

  <!-- ERREUR -->
  <div id="s-error" class="state">
    <div class="err-box">
      <p class="muted" id="err-msg" style="margin-bottom:8px">Erreur</p>
      <button id="btn-update">Nouveau cookie</button>
      <button class="btn-ghost" id="btn-retry">Réessayer</button>
    </div>
  </div>

  <!-- DONNÉES -->
  <div id="s-data" class="state">
    <div class="pct-value" id="pct">—%</div>
    <div class="bar-bg"><div class="bar-fill" id="bar" style="width:0%"></div></div>
    <div class="reset" id="reset"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = id => document.getElementById(id);

    let hasData = false;

    function show(id) {
      ['s-loading','s-setup','s-error','s-data'].forEach(s => {
        $(s).classList.toggle('active', s === id);
      });
    }

    $('btn-cookie').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
    $('btn-update').addEventListener('click', () => vscode.postMessage({ command: 'openSettings' }));
    $('btn-retry').addEventListener('click',  () => vscode.postMessage({ command: 'refresh' }));

    function barColor(p) {
      return p < 50 ? '#10b981' : p < 80 ? '#f59e0b' : '#ef4444';
    }

    function fmtReset(minutes) {
      if (minutes == null) { return ''; }
      if (minutes === 0)   { return 'Reset imminent'; }
      if (minutes < 60)    { return 'Reset dans ' + minutes + ' min'; }
      const h = Math.floor(minutes / 60), m = minutes % 60;
      return 'Reset dans ' + h + 'h' + (m ? m + 'min' : '');
    }

    window.addEventListener('message', ({ data: msg }) => {
      if (msg.type === 'loading') {
        // Premier chargement → spinner, refresh suivants → shimmer sur la barre
        if (!hasData) { show('s-loading'); }
        else          { $('bar').classList.add('refreshing'); }
        return;
      }

      if (msg.type === 'no_cookie') { show('s-setup'); return; }

      if (msg.type === 'error') {
        $('bar').classList.remove('refreshing');
        show('s-error');
        $('err-msg').textContent =
          msg.message === 'invalid_cookie' ? 'Cookie invalide ou expiré.' :
          msg.message === 'timeout'        ? 'Délai dépassé.' :
          msg.message || 'Erreur réseau';
        return;
      }

      if (msg.type === 'data') {
        $('bar').classList.remove('refreshing');
        hasData = true;
        show('s-data');
        const d = msg.data;
        const pct = d.bucket ? Math.round(d.bucket.utilization) : null;

        if (pct !== null) {
          const cls = pct < 50 ? 'low' : pct < 80 ? 'medium' : 'high';
          $('pct').textContent = pct + '%';
          $('pct').className = 'pct-value ' + cls;
          $('bar').style.width = pct + '%';
          $('bar').style.background = barColor(pct);
          $('reset').textContent = fmtReset(d.bucket.resetMinutes);
        } else {
          $('pct').textContent = '—';
          $('pct').className = 'pct-value low';
          $('reset').textContent = 'Données non disponibles';
        }
      }
    });
  </script>
</body>
</html>`;
  }

  private _nonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
