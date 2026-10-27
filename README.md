# HATE

A pretty, fully customizable terminal. macOS-style window, Dracula theme, Nerd Font icons, tabs, and adjustable transparency. Built with Tauri 2 + xterm.js (~10 MB app).

## Run it (Windows)

You need **Node.js 18+**, **Rust** (https://rustup.rs) and the **MSVC build tools** (Rust's installer offers them). WebView2 is already on Windows 10/11.

```powershell
npm install
npm run tauri dev      # run with hot reload
npm run tauri build    # make the installer
```

The installer ends up in `src-tauri/target/release/bundle/` (`.msi` and `.exe`). The first build takes a few minutes, and later builds are fast.

## zsh in WSL

The default tab runs `wsl.exe ~`, same as your Hyper setup, so it opens your WSL default shell (zsh).

You can change any shell command in **Settings → Shells**.

## Shortcuts

| Keys | Action |
|---|---|
| Ctrl+T / Ctrl+Shift+T | New tab (default shell), or ≡ menu → New tab |
| Ctrl+Shift+1 / 2 / 3 | New zsh / PowerShell / CMD tab |
| Ctrl+Shift+W | Close tab |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Shift+C | Copy |
| Ctrl+V / Ctrl+Shift+V | Paste |
| Ctrl+= / Ctrl+- / Ctrl+0 | Font bigger / smaller / reset |
| Ctrl+, | Settings |
| Middle-click tab | Close tab |
| Double-click title bar | Maximize |

## Customize

| What | Where |
|---|---|
| Name | `productName` in `src-tauri/tauri.conf.json` |
| Icon | Replace `app-icon.png` (1024×1024), then run `npx tauri icon app-icon.png` |
| Colors | `DRACULA` in `src/main.js`, UI colors at the top of `src/style.css` |
| Transparency, corners, font, cursor, shells | ≡ menu → Settings. Saved automatically |
| Shell profiles | `PROFILES` + `DEFAULTS.commands` in `src/main.js` |

The bundled font is JetBrainsMono Nerd Font (SIL OFL, see `public/fonts/OFL.txt`). Defaults to FiraCode Nerd Font Mono (from your Hyper config) and falls back to the bundled font if it's missing. To use any other installed Nerd Font, type its name in Settings → Font.

## Layout

```
src/main.js            tabs, xterm, settings, shortcuts
src/style.css          window, title bar, tabs, settings panel
index.html             markup
src-tauri/src/main.rs  one PTY per tab (portable-pty → ConPTY on Windows)
src-tauri/tauri.conf.json  window: frameless + transparent
```

Running `npm run dev` alone opens a browser preview with fake output, which is handy for tweaking CSS.
