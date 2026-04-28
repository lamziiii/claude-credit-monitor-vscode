# Claude Credit Monitor

Extension VS Code pour surveiller ta consommation Claude.ai en temps réel, directement dans la sidebar.


## Fonctionnalités

- **Utilisation en direct** — pourcentage de la session actuelle (bucket 5h / 1h / 7j)
- **Temps avant reset** — compte à rebours jusqu'au prochain reset de limite
- **Barre de progression** colorée (vert → orange → rouge)
- **Auto-refresh** configurable (30 secondes par défaut)
- Affiché dans la sidebar Explorer, toujours visible

## Installation

### Depuis le fichier .vsix

1. Télécharge `claude-credit-monitor-0.0.1.vsix`
2. Dans VS Code : **Ctrl+Shift+P** → `Install from VSIX` → sélectionne le fichier

### Depuis les sources

```bash
git clone https://github.com/lamziiii/claude-credit-monitor-vscode
cd claude-credit-monitor-vscode
npm install
npm run compile
npx @vscode/vsce package
# Installe le .vsix généré via Ctrl+Shift+P → Install from VSIX
```

## Configuration

### 1. Récupérer le cookie de session

1. Ouvre **claude.ai** dans ton navigateur et connecte-toi
2. Appuie sur **F12** pour ouvrir les DevTools
3. Onglet **Application** → **Cookies** → `https://claude.ai`
4. Copie la valeur du cookie **`sessionKey`**

### 2. Coller le cookie dans l'extension

Dans la sidebar VS Code, panneau **CLAUDE CREDITS** → clique sur **"Coller le cookie"**  
(ou **Ctrl+Shift+P** → `Claude Credits: Entrer le cookie de session`)

> Le cookie expire après quelques semaines. Si l'extension affiche une erreur, recommence l'étape 1.

### Paramètres disponibles

| Paramètre | Description | Défaut |
|-----------|-------------|--------|
| `claudeCredit.sessionCookie` | Valeur du cookie `sessionKey` | — |
| `claudeCredit.refreshInterval` | Intervalle de rafraîchissement (secondes) | `30` |

## Comment ça marche

L'extension appelle l'API web de claude.ai avec ton cookie de session (via `curl` pour contourner la détection TLS de Cloudflare) et lit le endpoint `/api/organizations/{uuid}/usage` qui retourne les buckets d'utilisation :

```json
{
  "five_hour":  { "utilization": 45.2, "resets_at": "2026-04-28T15:00:00Z" },
  "one_hour":   { "utilization": 12.0, "resets_at": "..." },
  "seven_day":  { "utilization": 8.3,  "resets_at": "..." }
}
```

Le bucket avec des données est affiché en priorité dans cet ordre : `5h > 1h > 7j`.

## Prérequis

- VS Code 1.85+
- Windows 10/11 (utilise `curl.exe` intégré)
- Un compte Claude.ai actif (Free, Pro ou Team)

## Inspiré de

[claude-usage-monitor](https://github.com/lamziiii/claude-usage-monitor) — version Python avec icône dans la barre des tâches
