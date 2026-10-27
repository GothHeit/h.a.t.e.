import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

const IN_TAURI = "__TAURI_INTERNALS__" in window;
const appWindow = IN_TAURI ? getCurrentWindow() : null;

// ── Dracula ──────────────────────────────────────────────
const DRACULA = {
  background: "#00000000", // window paints the (transparent) background
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  cursorAccent: "#282a36",
  selectionBackground: "#44475a",
  black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
  blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
  brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94", brightYellow: "#ffffa5",
  brightBlue: "#d6acff", brightMagenta: "#ff92df", brightCyan: "#a4ffff", brightWhite: "#ffffff",
};

// ── Shell profiles (Nerd Font glyphs as icons) ────────────
const PROFILES = {
  wsl:        { name: "zsh",        icon: "",      key: "1" },
  powershell: { name: "PowerShell", icon: "\u{f0a0a}",   key: "2" },
  cmd:        { name: "CMD",        icon: "",      key: "3" },
};

// ── Settings ──────────────────────────────────────────────
const DEFAULTS = {
  // Carried over from Kafka's .hyper.js
  opacity: 0.88,
  radius: 8,
  fontFamily: "FiraCode Nerd Font Mono",
  fontSize: 13,
  cursorStyle: "block",
  cursorBlink: false,
  bell: true,
  defaultProfile: "wsl",
  commands: { wsl: "wsl.exe ~", powershell: "powershell.exe -NoLogo", cmd: "cmd.exe" },
};
const KEY = "hate.settings.v1";

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { ...DEFAULTS, ...saved, commands: { ...DEFAULTS.commands, ...(saved.commands || {}) } };
  } catch { return structuredClone(DEFAULTS); }
}
function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {}
}
let settings = loadSettings();

const fontStack = () => `"${settings.fontFamily}", "JetBrainsMono Nerd Font", "Symbols Nerd Font", monospace`;

// ── Tabs ──────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const tabsEl = $("#tabs"), panesEl = $("#panes"), winEl = $("#window");
const tabs = new Map(); // id -> { id, profile, term, fit, pane, tabEl, alive, startedAt }
let activeId = null;
let nextId = 1;

function makeTerm() {
  const term = new Terminal({
    allowTransparency: true,
    theme: DRACULA,
    fontFamily: fontStack(),
    fontSize: settings.fontSize,
    lineHeight: 1,
    cursorStyle: settings.cursorStyle,
    cursorBlink: settings.cursorBlink,
    scrollback: 10000,
    allowProposedApi: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

async function newTab(profile = settings.defaultProfile) {
  const id = nextId++;
  const p = PROFILES[profile] || PROFILES.wsl;

  const pane = document.createElement("div");
  pane.className = "pane";
  panesEl.appendChild(pane);

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span class="icon ${profile}">${p.icon}</span><span class="name"></span><button class="x" title="Close tab (Ctrl+Shift+W)">×</button>`;
  tabEl.querySelector(".name").textContent = p.name;
  tabEl.addEventListener("mousedown", (e) => { if (e.button === 0 && !e.target.closest(".x")) activate(id); });
  tabEl.addEventListener("auxclick", (e) => { if (e.button === 1) closeTab(id); });
  tabEl.querySelector(".x").addEventListener("click", () => closeTab(id));
  tabsEl.appendChild(tabEl);

  const { term, fit } = makeTerm();
  term.open(pane);
  const tab = { id, profile, term, fit, pane, tabEl, alive: false, startedAt: Date.now() };
  tabs.set(id, tab);

  term.onBell(() => { if (settings.bell) beep(); });
  term.onTitleChange((t) => { if (t) tabEl.querySelector(".name").textContent = t; });
  term.onData((data) => {
    if (!tab.alive) { if (data === "\r") restartTab(tab); return; }
    if (IN_TAURI) invoke("pty_write", { id, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => { if (IN_TAURI && tab.alive) invoke("pty_resize", { id, cols, rows }).catch(() => {}); });
  term.attachCustomKeyEventHandler(handleKeys);

  activate(id);
  updateChrome();
  fit.fit(); // spawn at the real size, not xterm's 80×24 default
  await startShell(tab);
  return tab;
}

async function startShell(tab) {
  tab.startedAt = Date.now();
  if (!IN_TAURI) { demoOutput(tab); return; }
  // Live before the spawn returns: ConPTY opens with a cursor-position query that
  // xterm must be able to answer, or the shell never starts.
  tab.alive = true;
  try {
    await invoke("pty_spawn", {
      id: tab.id,
      shell: settings.commands[tab.profile] || "",
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
  } catch (err) {
    tab.alive = false;
    tab.term.write(`\x1b[38;2;255;85;85m✗ Could not start "${settings.commands[tab.profile]}": ${err}\x1b[0m\r\n`);
    tab.term.write(`\x1b[38;2;98;114;164mFix the command in Settings, then press Enter to retry.\x1b[0m\r\n`);
  }
}

function restartTab(tab) {
  tab.term.reset();
  startShell(tab);
}

function activate(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  activeId = id;
  for (const t of tabs.values()) {
    t.pane.classList.toggle("active", t.id === id);
    t.tabEl.classList.toggle("active", t.id === id);
  }
  requestAnimationFrame(() => { tab.fit.fit(); tab.term.focus(); });
  tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest" });
}

async function closeTab(id) {
  const tab = tabs.get(id);
  if (!tab) return;
  if (IN_TAURI && tab.alive) invoke("pty_kill", { id }).catch(() => {});
  tab.alive = false;
  tab.term.dispose();
  tab.pane.remove();
  tab.tabEl.remove();
  const ids = [...tabs.keys()];
  const idx = ids.indexOf(id);
  tabs.delete(id);
  if (tabs.size === 0) { if (IN_TAURI) appWindow.close(); else newTab(); return; }
  if (activeId === id) activate(ids[idx + 1] ?? ids[idx - 1]);
  updateChrome();
}

function cycleTab(dir) {
  const ids = [...tabs.keys()];
  const i = ids.indexOf(activeId);
  activate(ids[(i + dir + ids.length) % ids.length]);
}

function updateChrome() {
  winEl.classList.toggle("single", tabs.size === 1);
}

// ── PTY events from Rust ─────────────────────────────────
if (IN_TAURI) {
  listen("pty-output", ({ payload }) => {
    tabs.get(payload.id)?.term.write(new Uint8Array(payload.data));
  });
  listen("pty-exit", ({ payload: id }) => {
    const tab = tabs.get(id);
    if (!tab || !tab.alive) return;
    tab.alive = false;
    // A shell that dies instantly is probably misconfigured: keep the tab so the error is visible.
    if (Date.now() - tab.startedAt < 1500) {
      tab.term.write(`\r\n\x1b[38;2;98;114;164m[process exited — press Enter to restart]\x1b[0m\r\n`);
    } else {
      closeTab(id);
    }
  });
}

// ── Bell ─────────────────────────────────────────────────
let audio;
function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = "sine"; o.frequency.value = 880;
    g.gain.setValueAtTime(0.12, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.15);
    o.connect(g).connect(audio.destination);
    o.start(); o.stop(audio.currentTime + 0.15);
  } catch {}
}

// ── Keyboard shortcuts ───────────────────────────────────
function handleKeys(e) {
  if (e.type !== "keydown") return true;
  const k = e.key.toLowerCase();
  const tab = tabs.get(activeId);

  if (e.ctrlKey && e.shiftKey) {
    if (k === "t") { newTab(); return false; }
    if (k === "w") { closeTab(activeId); return false; }
    if (k === "c") { const s = tab?.term.getSelection(); if (s) navigator.clipboard.writeText(s); return false; }
    for (const [pid, p] of Object.entries(PROFILES)) {
      if (e.code === `Digit${p.key}`) { newTab(pid); return false; }
    }
  }
  // Hyper keymaps you had: ctrl+t new tab, ctrl+v paste
  if (e.ctrlKey && !e.shiftKey && !e.altKey && k === "t") { newTab(); return false; }
  // Returning false lets the webview's native paste event reach xterm (no double paste).
  if (e.ctrlKey && !e.altKey && k === "v") return false;
  if (e.ctrlKey && k === "tab") { cycleTab(e.shiftKey ? -1 : 1); return false; }
  if (e.ctrlKey && !e.shiftKey && k === ",") { toggleSettings(); return false; }
  if (e.ctrlKey && (k === "=" || k === "+")) { setSetting("fontSize", Math.min(32, settings.fontSize + 1)); return false; }
  if (e.ctrlKey && k === "-") { setSetting("fontSize", Math.max(8, settings.fontSize - 1)); return false; }
  if (e.ctrlKey && k === "0") { setSetting("fontSize", DEFAULTS.fontSize); return false; }
  return true;
}
window.addEventListener("keydown", (e) => {
  // Shortcuts that should work even when the settings panel has focus
  if (e.key === "Escape") { closeMenus(); }
  if (e.ctrlKey && e.key === ",") { e.preventDefault(); toggleSettings(); }
});

// ── Window controls (macOS traffic lights) ───────────────
$("#btn-close").onclick = () => appWindow?.close();
$("#btn-min").onclick = () => appWindow?.minimize();
$("#btn-max").onclick = () => appWindow?.toggleMaximize();
if (IN_TAURI) {
  const syncMax = async () => winEl.classList.toggle("maximized", await appWindow.isMaximized());
  appWindow.onResized(syncMax);
  appWindow.onFocusChanged(({ payload }) => document.body.classList.toggle("blurred", !payload));
  syncMax();
}
new ResizeObserver(() => tabs.get(activeId)?.fit.fit()).observe(panesEl);

// ── ≡ menu: new tabs + settings ──────────────────────────
const menu = $("#menu");
const menuBtn = $("#btn-menu");
menu.innerHTML =
  `<div class="label">New tab</div>` +
  Object.entries(PROFILES).map(([id, p]) =>
    `<button data-profile="${id}"><span class="icon ${id}">${p.icon}</span>${p.name}<span class="hint">Ctrl+Shift+${p.key}</span></button>`
  ).join("") +
  `<hr><button data-action="settings"><span class="icon"></span>Settings<span class="hint">Ctrl+,</span></button>`;
menu.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  menu.hidden = true;
  menuBtn.classList.remove("on");
  if (b.dataset.action === "settings") toggleSettings(true);
  else newTab(b.dataset.profile);
});
menuBtn.onclick = (e) => {
  e.stopPropagation();
  if (!panel.hidden) { toggleSettings(false); return; }
  menu.hidden = !menu.hidden;
  menuBtn.classList.toggle("on", !menu.hidden);
};

// ── Settings panel ───────────────────────────────────────
const panel = $("#settings");
function toggleSettings(force) {
  panel.hidden = force === undefined ? !panel.hidden : !force;
  menuBtn.classList.toggle("on", !panel.hidden);
  if (panel.hidden) tabs.get(activeId)?.term.focus();
}
function closeMenus() {
  menu.hidden = true;
  menuBtn.classList.remove("on");
  if (!panel.hidden) toggleSettings(false);
}
document.addEventListener("mousedown", (e) => {
  if (!e.target.closest("#menu, #btn-menu")) { menu.hidden = true; if (panel.hidden) menuBtn.classList.remove("on"); }
  if (!panel.hidden && !e.target.closest("#settings, #btn-menu")) toggleSettings(false);
});

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  applySettings();
}

function applySettings() {
  const root = document.documentElement.style;
  root.setProperty("--opacity", settings.opacity);
  root.setProperty("--radius", `${settings.radius}px`);
  for (const t of tabs.values()) {
    t.term.options.fontFamily = fontStack();
    t.term.options.fontSize = settings.fontSize;
    t.term.options.cursorStyle = settings.cursorStyle;
    t.term.options.cursorBlink = settings.cursorBlink;
  }
  tabs.get(activeId)?.fit.fit();
  syncForm();
}

function syncForm() {
  $("#s-opacity").value = settings.opacity;
  $("#v-opacity").textContent = `${Math.round((1 - settings.opacity) * 100)}%`;
  $("#s-radius").value = settings.radius;
  $("#v-radius").textContent = `${settings.radius}px`;
  if (document.activeElement !== $("#s-font")) $("#s-font").value = settings.fontFamily;
  $("#s-size").value = settings.fontSize;
  $("#v-size").textContent = `${settings.fontSize}px`;
  $("#s-cursor").value = settings.cursorStyle;
  $("#s-blink").checked = settings.cursorBlink;
  $("#s-bell").checked = settings.bell;
  $("#s-default").value = settings.defaultProfile;
  for (const id of Object.keys(PROFILES)) {
    const input = $(`#cmd-${id}`);
    if (input && document.activeElement !== input) input.value = settings.commands[id];
  }
}

// Build profile inputs
$("#s-default").innerHTML = Object.entries(PROFILES).map(([id, p]) => `<option value="${id}">${p.name}</option>`).join("");
$("#s-profiles").innerHTML = Object.entries(PROFILES).map(([id, p]) =>
  `<label>${p.name} command<input type="text" id="cmd-${id}" spellcheck="false" /></label>`
).join("");
for (const id of Object.keys(PROFILES)) {
  $(`#cmd-${id}`).addEventListener("change", (e) => {
    settings.commands = { ...settings.commands, [id]: e.target.value.trim() || DEFAULTS.commands[id] };
    saveSettings(); syncForm();
  });
}

$("#s-opacity").oninput = (e) => setSetting("opacity", +e.target.value);
$("#s-radius").oninput = (e) => setSetting("radius", +e.target.value);
$("#s-size").oninput = (e) => setSetting("fontSize", +e.target.value);
$("#s-cursor").onchange = (e) => setSetting("cursorStyle", e.target.value);
$("#s-blink").onchange = (e) => setSetting("cursorBlink", e.target.checked);
$("#s-bell").onchange = (e) => setSetting("bell", e.target.checked);
$("#s-default").onchange = (e) => setSetting("defaultProfile", e.target.value);
$("#s-font").onchange = async (e) => {
  const f = e.target.value.trim() || DEFAULTS.fontFamily;
  await document.fonts.load(`14px "${f}"`).catch(() => {});
  setSetting("fontFamily", f);
};
$("#s-reset").onclick = () => { settings = structuredClone(DEFAULTS); saveSettings(); applySettings(); };

// ── Browser-preview demo (when not running inside Tauri) ──
function demoOutput(tab) {
  const t = tab.term;
  const ps1 = "\x1b[38;2;80;250;123m kafka\x1b[0m \x1b[38;2;189;147;249m ~/projects/hate\x1b[0m \x1b[38;2;255;121;198m main\x1b[0m\r\n\x1b[38;2;255;121;198m❯\x1b[0m ";
  t.write(ps1 + "ls\r\n");
  t.write("\x1b[38;2;189;147;249m src\x1b[0m  \x1b[38;2;189;147;249m src-tauri\x1b[0m  \x1b[38;2;241;250;140m package.json\x1b[0m  \x1b[38;2;139;233;253m index.html\x1b[0m  \x1b[38;2;248;248;242m README.md\x1b[0m\r\n");
  t.write(ps1 + "git log --oneline -3\r\n");
  t.write("\x1b[33ma1f3c9e\x1b[0m tabs + shell profiles\r\n\x1b[33m7d02b41\x1b[0m dracula + nerd font\r\n\x1b[33m03ee5aa\x1b[0m initial window\r\n");
  t.write(ps1);
}

// ── Boot ─────────────────────────────────────────────────
(async () => {
  await Promise.all([
    document.fonts.load(`14px "JetBrainsMono Nerd Font"`),
    document.fonts.load(`bold 14px "JetBrainsMono Nerd Font"`),
  ]).catch(() => {});
  applySettings();
  await newTab();
})();
