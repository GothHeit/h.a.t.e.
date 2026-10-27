// Hide the extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// One running shell, owned by one tab.
struct Pty {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
}

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
    if let Some(home) = home_dir() {
        cmd.cwd(home);
    }

    let size = PtySize { rows: rows.max(1), cols: cols.max(1), pixel_width: 0, pixel_height: 0 };
    let pair = native_pty_system().openpty(size).map_err(|e| e.to_string())?;
    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Replace any previous shell for this tab (restart).
    if let Some(mut old) = ptys.0.lock().unwrap().insert(id, Pty { writer, master: pair.master, child }) {
        let _ = old.child.kill();
    }

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
        let _ = pty.child.kill();
    }
}

fn main() {
    tauri::Builder::default()
        .manage(Ptys::default())
        .invoke_handler(tauri::generate_handler![pty_spawn, pty_write, pty_resize, pty_kill])
        .run(tauri::generate_context!())
        .expect("error while running HATE");
}
