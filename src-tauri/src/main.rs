#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};

const API_ADDR: &str = "127.0.0.1:38674";

struct BackendState {
    child: Mutex<Option<CommandChild>>,
    token: String,
}

#[tauri::command]
fn backend_url() -> String {
    format!("http://{API_ADDR}")
}

/// Случайный токен на один запуск: им защищён локальный сервис syne-desktop-api.
fn generate_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("system random source is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
fn backend_token(state: tauri::State<'_, BackendState>) -> String {
    state.token.clone()
}

fn spawn_backend(app: &AppHandle, token: &str) -> Result<CommandChild, String> {
    let mut args = vec![
        "--addr".to_string(),
        API_ADDR.to_string(),
        "--exit-on-stdin-close".to_string(),
    ];
    if let Ok(server) = std::env::var("SYNE_CLOUD_SERVER") {
        args.push("--server".to_string());
        args.push(server);
    }
    let (mut rx, child) = app
        .shell()
        .sidecar("syne-desktop-api")
        .map_err(|e| format!("failed to configure sidecar: {e}"))?
        .args(args)
        .env("SYNE_API_TOKEN", token)
        .spawn()
        .map_err(|e| format!("failed to start sidecar: {e}"))?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(l) => println!("[sidecar] {}", String::from_utf8_lossy(&l).trim_end()),
                CommandEvent::Stderr(l) => eprintln!("[sidecar] {}", String::from_utf8_lossy(&l).trim_end()),
                CommandEvent::Error(e) => eprintln!("sidecar error: {e}"),
                CommandEvent::Terminated(p) => eprintln!("sidecar terminated: {:?}", p.code),
                _ => {}
            }
        }
    });
    Ok(child)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState {
            child: Mutex::new(None),
            token: generate_token(),
        })
        .invoke_handler(tauri::generate_handler![backend_url, backend_token])
        .setup(|app| {
            let token = app.state::<BackendState>().token.clone();
            let child = spawn_backend(&app.handle().clone(), &token)?;
            app.state::<BackendState>().child.lock().unwrap().replace(child);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(child) = app_handle.state::<BackendState>().child.lock().unwrap().take() {
                let _ = child.kill();
            }
        }
    });
}
