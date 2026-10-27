// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

/// One running shell, owned by one tab.
struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Tells this shell apart from a later one restarted in the same tab.
    serial: u64,
}

static SERIAL: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct Ptys(Mutex<HashMap<u32, Pty>>);

#[derive(Clone, Serialize)]
struct Output {
    id: u32,
    data: Vec<u8>,
}

fn default_shell() -> String {
    if cfg!(windows) {
        "wsl.exe --cd ~ --exec zsh -l".into()
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
    }
}

fn home_dir() -> Option<String> {
    std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).ok()
}

#[tauri::command]
fn pty_spawn(
    app: AppHandle,
    ptys: State<Ptys>,
    id: u32,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let shell = if shell.trim().is_empty() { default_shell() } else { shell };
    let mut parts = shell.split_whitespace();
    let program = parts.next().ok_or("empty shell command")?;

    let mut cmd = CommandBuilder::new(program);
    cmd.args(parts);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "HATE");
    if cfg!(windows) {
        // wsl.exe only passes the variables listed in WSLENV through to Linux.
        let shared = std::env::var("WSLENV").unwrap_or_default();
        let sep = if shared.is_empty() { "" } else { ":" };
        cmd.env("WSLENV", format!("{shared}{sep}COLORTERM:TERM_PROGRAM"));
    }
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }

    let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();
    let serial = SERIAL.fetch_add(1, Ordering::Relaxed);

    // Replace any previous shell for this tab (restart).
    if let Some(mut old) = ptys.0.lock().unwrap().insert(id, Pty { writer, master: pair.master, killer, serial }) {
        let _ = old.killer.kill();
    }

    // ConPTY keeps the output pipe open after the shell exits, so the reader below
    // never sees EOF on its own. Wait for the shell instead, then drop its master:
    // that closes the pseudoconsole, and the reader drains what's left and stops.
    let waiter = app.clone();
    std::thread::spawn(move || {
        let _ = child.wait();
        let ptys = waiter.state::<Ptys>();
        let mut map = ptys.0.lock().unwrap();
        let done = if map.get(&id).is_some_and(|p| p.serial == serial) { map.remove(&id) } else { None };
        drop(map);
        drop(done);
    });

    std::thread::spawn(move || {
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let _ = app.emit("pty-output", Output { id, data: buf[..n].to_vec() });
                }
            }
        }
        let _ = app.emit("pty-exit", id);
    });

    Ok(())
}

#[tauri::command]
fn pty_write(ptys: State<Ptys>, id: u32, data: String) -> Result<(), String> {
    let mut map = ptys.0.lock().unwrap();
    let pty = map.get_mut(&id).ok_or("no such tab")?;
    pty.writer.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    pty.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_resize(ptys: State<Ptys>, id: u32, cols: u16, rows: u16) -> Result<(), String> {
    let map = ptys.0.lock().unwrap();
    let pty = map.get(&id).ok_or("no such tab")?;
    pty.master
        .resize(PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn pty_kill(ptys: State<Ptys>, id: u32) {
    if let Some(mut pty) = ptys.0.lock().unwrap().remove(&id) {
        let _ = pty.killer.kill();
    }
}

/// WebView2's browser shortcuts (F5/Ctrl+R reload, Ctrl+P print, Ctrl+F find…) would reload
/// the page and drop every tab. Editing keys like Ctrl+C/V keep working.
#[cfg(windows)]
fn disable_browser_keys(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;
    window.with_webview(|webview| unsafe {
        let settings = webview.controller().CoreWebView2().and_then(|core| core.Settings());
        match settings.and_then(|s| s.cast::<ICoreWebView2Settings3>()) {
            Ok(settings) => { let _ = settings.SetAreBrowserAcceleratorKeysEnabled(false); }
            Err(e) => eprintln!("could not disable browser keys: {e}"),
        }
    })
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .setup(|_app| {
            #[cfg(windows)]
            disable_browser_keys(&_app.get_webview_window("main").expect("main window"))?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill])
        .run(tauri::generate_context!())
        .expect("error while running HATE");
}
