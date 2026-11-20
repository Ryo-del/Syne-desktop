#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
};
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
/// Случайный токен на один запуск: им защищено локальное API (syne-ui-api).
fn generate_token() -> String {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("system random source is unavailable");
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[tauri::command]
fn backend_token(state: tauri::State<'_, BackendState>) -> String {
    state.token.clone()
}

const OPEN_DIR_NAME: &str = "syne-desktop-open";

/// Папка рабочей области на рабочем столе. Отличается от папки Syne Study («workspace»),
/// иначе обе программы видели бы файлы друг друга как свои изменения.
const WORKSPACE_DIR_NAME: &str = "Syne Desktop workspace";

/// Папка для файлов, скачанных ради «Открыть как». Чистится при каждом запуске.
fn open_dir() -> PathBuf {
    std::env::temp_dir().join(OPEN_DIR_NAME)
}

#[tauri::command]
fn open_temp_dir() -> Result<String, String> {
    let dir = open_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create the temp folder: {e}"))?;
    dir.to_str()
        .map(str::to_string)
        .ok_or_else(|| "temp folder path is not valid UTF-8".to_string())
}

/// Показывает системное окно «Открыть с помощью». Открывает только файлы из
/// нашей временной папки: интерфейс не может использовать команду, чтобы
/// запустить произвольный файл на компьютере.
#[tauri::command]
fn open_with_dialog(path: String) -> Result<(), String> {
    let dir = open_dir()
        .canonicalize()
        .map_err(|e| format!("temp folder is unavailable: {e}"))?;
    let file = PathBuf::from(&path)
        .canonicalize()
        .map_err(|e| format!("file is unavailable: {e}"))?;
    if !file.starts_with(&dir) || !file.is_file() {
        return Err("only files downloaded for opening can be opened".to_string());
    }
    spawn_open_as(Path::new(&path))
}

fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let desktop = app
        .path()
        .desktop_dir()
        .map_err(|e| format!("cannot locate Desktop: {e}"))?;
    let path = desktop.join(WORKSPACE_DIR_NAME);
    std::fs::create_dir_all(&path).map_err(|e| format!("cannot create workspace: {e}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace: {e}"))?;
    let desktop = desktop
        .canonicalize()
        .map_err(|e| format!("cannot resolve Desktop: {e}"))?;
    if !canonical.starts_with(&desktop) || canonical.parent() != Some(desktop.as_path()) {
        return Err("workspace must be a direct child of Desktop".into());
    }
    Ok(canonical)
}

#[tauri::command]
fn get_workspace_dir(app: AppHandle) -> Result<String, String> {
    workspace_dir(&app)?
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "workspace path is not valid UTF-8".into())
}

fn checked_workspace_relative(relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return Err("invalid workspace relative path".into());
    }
    Ok(rel.to_path_buf())
}

#[tauri::command]
fn workspace_subdir(app: AppHandle, relative: String) -> Result<String, String> {
    let root = workspace_dir(&app)?;
    let rel = checked_workspace_relative(&relative)?;
    let mut target = root.clone();
    for component in rel.components() {
        let std::path::Component::Normal(name) = component else {
            return Err("invalid workspace relative path".into());
        };
        target.push(name);
        match std::fs::symlink_metadata(&target) {
            Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => {
                return Err("workspace path contains a symlink or non-folder".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&target)
                    .map_err(|e| format!("cannot create workspace folder: {e}"))?;
            }
            Err(error) => return Err(format!("cannot inspect workspace path: {error}")),
        }
    }
    let canonical = target
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace folder: {e}"))?;
    if !canonical.starts_with(&root) {
        return Err("workspace path escapes its root".into());
    }
    canonical
        .to_str()
        .map(str::to_owned)
        .ok_or_else(|| "workspace path is not valid UTF-8".into())
}

/// Создаёт пустой файл в папке workspace (dir — путь из workspace_subdir).
/// Нужен для файлов 0 Б: их не скачиваем, а создаём с тем же именем.
/// Если имя занято, как и при обычном скачивании берётся «имя (1).ext».
#[tauri::command]
fn workspace_create_empty(app: AppHandle, dir: String, name: String) -> Result<String, String> {
    let root = workspace_dir(&app)?;
    let dir = PathBuf::from(dir)
        .canonicalize()
        .map_err(|e| format!("cannot resolve workspace folder: {e}"))?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err("folder is outside workspace".into());
    }
    let mut parts = Path::new(&name).components();
    match (parts.next(), parts.next()) {
        (Some(std::path::Component::Normal(_)), None) => {}
        _ => return Err("invalid file name".into()),
    }
    let path = Path::new(&name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 0..1000 {
        let candidate = if i == 0 {
            dir.join(&name)
        } else {
            dir.join(format!("{stem} ({i}){ext}"))
        };
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(_) => {
                return candidate
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| "workspace path is not valid UTF-8".into())
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("cannot create empty file: {e}")),
        }
    }
    Err("cannot choose a file name".into())
}

#[cfg(test)]
mod workspace_tests {
    use super::{checked_workspace_file, checked_workspace_relative};
    use std::{fs, path::PathBuf};

    #[test]
    fn accepts_nested_unicode_relative_paths() {
        assert!(checked_workspace_relative("Документы/проект/file.txt").is_ok());
    }

    #[test]
    fn rejects_parent_and_absolute_paths() {
        assert!(checked_workspace_relative("../outside.txt").is_err());
        assert!(checked_workspace_relative("/tmp/outside.txt").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinks_inside_workspace() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("syne-workspace-test-{}", std::process::id()));
        let outside =
            std::env::temp_dir().join(format!("syne-workspace-outside-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_file(&outside);
        fs::create_dir_all(&root).unwrap();
        fs::write(&outside, b"test").unwrap();
        symlink(&outside, root.join("link.txt")).unwrap();
        assert!(checked_workspace_file(&root, "link.txt").is_err());
        fs::remove_dir_all(PathBuf::from(root)).unwrap();
        fs::remove_file(outside).unwrap();
    }
}

fn checked_workspace_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = checked_workspace_relative(relative)?;
    let mut path = root.to_path_buf();
    let components: Vec<_> = rel.components().collect();
    for (index, component) in components.iter().enumerate() {
        let std::path::Component::Normal(name) = component else {
            return Err("invalid workspace relative path".into());
        };
        path.push(name);
        let meta = std::fs::symlink_metadata(&path)
            .map_err(|e| format!("cannot inspect workspace file: {e}"))?;
        if meta.file_type().is_symlink() {
            return Err("workspace file path contains a symlink".into());
        }
        if index + 1 == components.len() {
            if !meta.is_file() {
                return Err("workspace path is not a regular file".into());
            }
        } else if !meta.is_dir() {
            return Err("workspace file parent is not a folder".into());
        }
    }
    Ok(path)
}

#[tauri::command]
fn workspace_file_path(app: AppHandle, relative: String) -> Result<String, String> {
    let root = workspace_dir(&app)?;
    let file = checked_workspace_file(&root, &relative)?;
    file.to_str()
        .map(str::to_owned)
        .ok_or_else(|| "workspace path is not valid UTF-8".into())
}

#[derive(Default, Serialize, Deserialize)]
struct WorkspaceManifest {
    #[serde(default)]
    files: BTreeMap<String, WorkspaceFileState>,
}

#[derive(Serialize, Deserialize)]
struct WorkspaceFileState {
    digest: String,
    target_path: String,
    base_mod_time: i64,
}

#[derive(Serialize)]
struct WorkspaceChange {
    path: String,
    status: String,
    bytes: u64,
    digest: String,
    target_path: String,
    base_mod_time: i64,
}

#[derive(Serialize)]
struct WorkspaceDiff {
    changes: Vec<WorkspaceChange>,
}

fn workspace_manifest_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot locate app data: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create app data: {e}"))?;
    Ok(dir.join("workspace-manifest.json"))
}

fn read_workspace_manifest(app: &AppHandle) -> Result<WorkspaceManifest, String> {
    let path = workspace_manifest_path(app)?;
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|e| format!("workspace manifest is invalid: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(WorkspaceManifest::default())
        }
        Err(error) => Err(format!("cannot read workspace manifest: {error}")),
    }
}

fn write_workspace_manifest(app: &AppHandle, manifest: &WorkspaceManifest) -> Result<(), String> {
    let path = workspace_manifest_path(app)?;
    let temp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec(manifest).map_err(|e| e.to_string())?;
    std::fs::write(&temp, bytes).map_err(|e| format!("cannot write workspace manifest: {e}"))?;
    #[cfg(not(target_os = "windows"))]
    std::fs::rename(&temp, &path).map_err(|e| format!("cannot save workspace manifest: {e}"))?;
    #[cfg(target_os = "windows")]
    {
        let backup = path.with_extension("json.bak");
        if backup.exists() {
            std::fs::remove_file(&backup)
                .map_err(|e| format!("cannot replace workspace manifest: {e}"))?;
        }
        let had_old = path.exists();
        if had_old {
            std::fs::rename(&path, &backup)
                .map_err(|e| format!("cannot stage workspace manifest: {e}"))?;
        }
        if let Err(error) = std::fs::rename(&temp, &path) {
            if had_old {
                let _ = std::fs::rename(&backup, &path);
            }
            return Err(format!("cannot save workspace manifest: {error}"));
        }
        if had_old {
            let _ = std::fs::remove_file(backup);
        }
    }
    Ok(())
}

fn workspace_file_digest(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("cannot open workspace file: {e}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("cannot read workspace file: {e}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn scan_workspace(
    root: &Path,
    dir: &Path,
    current: &mut BTreeMap<String, (u64, String)>,
) -> Result<(), String> {
    for item in std::fs::read_dir(dir).map_err(|e| format!("cannot scan workspace: {e}"))? {
        let item = item.map_err(|e| e.to_string())?;
        let name = item.file_name().to_string_lossy().to_lowercase();
        if matches!(
            name.as_str(),
            ".ds_store"
                | ".appledouble"
                | "__macosx"
                | "thumbs.db"
                | "desktop.ini"
                | ".spotlight-v100"
                | ".trashes"
                | ".fseventsd"
                | ".temporaryitems"
                | ".documentrevisions-v100"
        ) || name.starts_with("._")
        {
            continue;
        }
        let path = item.path();
        let kind = item.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            scan_workspace(root, &path, current)?;
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/");
            let size = item.metadata().map_err(|e| e.to_string())?.len();
            current.insert(relative, (size, workspace_file_digest(&path)?));
        }
    }
    Ok(())
}

#[tauri::command]
fn record_workspace_file(
    app: AppHandle,
    path: String,
    target_path: String,
    base_mod_time: i64,
) -> Result<(), String> {
    let root = workspace_dir(&app)?;
    let file = PathBuf::from(path)
        .canonicalize()
        .map_err(|e| format!("cannot resolve downloaded file: {e}"))?;
    if !file.starts_with(&root) || !file.is_file() {
        return Err("downloaded file is outside workspace".into());
    }
    let relative = file
        .strip_prefix(&root)
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .replace('\\', "/");
    let mut manifest = read_workspace_manifest(&app)?;
    manifest.files.insert(
        relative,
        WorkspaceFileState {
            digest: workspace_file_digest(&file)?,
            target_path,
            base_mod_time,
        },
    );
    write_workspace_manifest(&app, &manifest)
}

#[tauri::command]
fn workspace_diff(app: AppHandle) -> Result<WorkspaceDiff, String> {
    let root = workspace_dir(&app)?;
    let mut current = BTreeMap::new();
    scan_workspace(&root, &root, &mut current)?;
    let manifest = read_workspace_manifest(&app)?;
    let mut changes = Vec::new();
    for (path, (bytes, digest)) in current {
        let state = manifest.files.get(&path);
        let status = match state {
            None => "Новый",
            Some(previous) if previous.digest != digest => "Изменён",
            Some(_) => continue,
        };
        let (target_path, base_mod_time) = state
            .map(|s| (s.target_path.clone(), s.base_mod_time))
            .unwrap_or_else(|| (path.clone(), 0));
        changes.push(WorkspaceChange {
            path,
            status: status.into(),
            bytes,
            digest,
            target_path,
            base_mod_time,
        });
    }
    for path in manifest.files.keys() {
        let rel = match checked_workspace_relative(path) {
            Ok(rel) => rel,
            Err(_) => continue,
        };
        if !root.join(rel).exists() {
            changes.push(WorkspaceChange {
                path: path.clone(),
                status: "Удалён локально (сервер не затронут)".into(),
                bytes: 0,
                digest: String::new(),
                target_path: String::new(),
                base_mod_time: 0,
            });
        }
    }
    Ok(WorkspaceDiff { changes })
}

#[tauri::command]
fn mark_workspace_uploaded(
    app: AppHandle,
    relative: String,
    digest: String,
    target_path: String,
    base_mod_time: i64,
) -> Result<(), String> {
    let root = workspace_dir(&app)?;
    let file = checked_workspace_file(&root, &relative)?;
    let current = workspace_file_digest(&file)?;
    if current != digest {
        return Err("workspace file changed while uploading".into());
    }
    let mut manifest = read_workspace_manifest(&app)?;
    manifest.files.insert(
        relative,
        WorkspaceFileState {
            digest,
            target_path,
            base_mod_time,
        },
    );
    write_workspace_manifest(&app, &manifest)
}

/// Удаляет из рабочей области файл, который уже выгружен на сервер. Если файл
/// успели изменить после выгрузки, он остаётся на месте.
#[tauri::command]
fn remove_workspace_uploaded(app: AppHandle, relative: String, digest: String) -> Result<(), String> {
    let root = workspace_dir(&app)?;
    let file = checked_workspace_file(&root, &relative)?;
    let current = workspace_file_digest(&file)?;
    if current != digest {
        return Err("workspace file changed after uploading; it was kept".into());
    }
    std::fs::remove_file(&file).map_err(|e| format!("cannot remove uploaded file: {e}"))?;
    let mut manifest = read_workspace_manifest(&app)?;
    manifest.files.remove(&relative);
    write_workspace_manifest(&app, &manifest)
}

#[tauri::command]
fn open_workspace(app: AppHandle, vscode: bool) -> Result<(), String> {
    let path = workspace_dir(&app)?;
    #[cfg(target_os = "windows")]
    let (program, args): (&str, Vec<String>) = if vscode {
        ("code", vec![path.to_string_lossy().into_owned()])
    } else {
        ("explorer.exe", vec![path.to_string_lossy().into_owned()])
    };
    #[cfg(target_os = "macos")]
    let (program, args): (&str, Vec<String>) = if vscode {
        ("code", vec![path.to_string_lossy().into_owned()])
    } else {
        ("open", vec![path.to_string_lossy().into_owned()])
    };
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let (program, args): (&str, Vec<String>) = if vscode {
        ("code", vec![path.to_string_lossy().into_owned()])
    } else {
        ("xdg-open", vec![path.to_string_lossy().into_owned()])
    };
    std::process::Command::new(program)
        .args(args)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open workspace: {e}"))
}

#[cfg(target_os = "windows")]
fn spawn_open_as(file: &Path) -> Result<(), String> {
    // Окно «Каким образом вы хотите открыть этот файл?»
    std::process::Command::new("rundll32.exe")
        .arg("shell32.dll,OpenAs_RunDLL")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot show the Open with dialog: {e}"))
}

#[cfg(target_os = "macos")]
fn spawn_open_as(file: &Path) -> Result<(), String> {
    // В macOS нет такого системного окна: открываем в программе по умолчанию.
    std::process::Command::new("open")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open the file: {e}"))
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn spawn_open_as(file: &Path) -> Result<(), String> {
    std::process::Command::new("xdg-open")
        .arg(file)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("cannot open the file: {e}"))
}
#[tauri::command]
fn set_app_icon(app: AppHandle, icon_bytes: Vec<u8>) -> Result<(), String> {
    set_platform_app_icon(app, icon_bytes)
}
#[cfg(target_os = "macos")]
fn set_platform_app_icon(app: AppHandle, icon_bytes: Vec<u8>) -> Result<(), String> {
    use objc2::{AllocAnyThread, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    use std::{sync::mpsc, time::Duration};

    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let result = || {
            let marker = unsafe { MainThreadMarker::new_unchecked() };
            let app = NSApplication::sharedApplication(marker);
            let data = NSData::with_bytes(&icon_bytes);

            let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
                return Err("failed to decode selected app icon".to_string());
            };

            unsafe { app.setApplicationIconImage(Some(&image)) };

            Ok(())
        };
        let _ = tx.send(result());
    })
    .map_err(|err| format!("failed to schedule app icon update: {err}"))?;

    rx.recv_timeout(Duration::from_secs(3))
        .map_err(|err| format!("timed out while applying app icon: {err}"))?
}

#[cfg(target_os = "windows")]
fn set_platform_app_icon(app: AppHandle, icon_bytes: Vec<u8>) -> Result<(), String> {
    use tauri::image::Image;

    let image = Image::from_bytes(&icon_bytes)
        .map_err(|err| format!("failed to decode selected app icon: {err}"))?;

    let mut hwnds = Vec::new();
    for window in app.webview_windows().values() {
        // Tauri меняет только маленькую иконку (ICON_SMALL) — ту, что в заголовке окна.
        window
            .set_icon(image.clone())
            .map_err(|err| format!("failed to apply app icon: {err}"))?;
        let hwnd = window
            .hwnd()
            .map_err(|err| format!("failed to get window handle: {err}"))?;
        hwnds.push(hwnd.0);
    }

    // Панель задач и Alt+Tab берут большую иконку (ICON_BIG), её ставим сами.
    set_windows_big_icon(&hwnds, image.rgba(), image.width(), image.height())
}

#[cfg(target_os = "windows")]
fn set_windows_big_icon(
    hwnds: &[*mut std::ffi::c_void],
    rgba: &[u8],
    width: u32,
    height: u32,
) -> Result<(), String> {
    use std::sync::Mutex;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateIcon, DestroyIcon, SendMessageW, ICON_BIG, SM_CXICON, WM_SETICON,
    };

    // Иконка, которую мы поставили прошлый раз. Её можно уничтожить только после замены.
    static CURRENT_BIG_ICON: Mutex<usize> = Mutex::new(0);

    let Some(&first) = hwnds.first() else {
        return Ok(());
    };
    let dpi = unsafe { GetDpiForWindow(first) };
    let size = match unsafe { GetSystemMetricsForDpi(SM_CXICON, dpi) } {
        n if n > 0 => n as u32,
        _ => 32,
    };

    let mut pixels = downscale_rgba(rgba, width, height, size);
    for px in pixels.chunks_exact_mut(4) {
        px.swap(0, 2); // RGBA -> BGRA
    }
    // При 32-битном цвете прозрачность берётся из альфа-канала, маска остаётся нулевой.
    let and_mask = vec![0u8; (size * size) as usize];
    let icon = unsafe {
        CreateIcon(
            std::ptr::null_mut(),
            size as i32,
            size as i32,
            1,
            32,
            and_mask.as_ptr(),
            pixels.as_ptr(),
        )
    };
    if icon.is_null() {
        return Err(format!(
            "failed to create app icon: {}",
            std::io::Error::last_os_error()
        ));
    }

    for &hwnd in hwnds {
        unsafe { SendMessageW(hwnd, WM_SETICON, ICON_BIG as usize, icon as isize) };
    }

    let mut current = CURRENT_BIG_ICON.lock().map_err(|err| err.to_string())?;
    let previous = std::mem::replace(&mut *current, icon as usize);
    if previous != 0 {
        unsafe { DestroyIcon(previous as _) };
    }
    Ok(())
}

// Уменьшение усреднением по области; цвет взвешивается по альфе, чтобы края не темнели.
#[cfg(target_os = "windows")]
fn downscale_rgba(rgba: &[u8], width: u32, height: u32, size: u32) -> Vec<u8> {
    let mut out = vec![0u8; (size * size * 4) as usize];
    for y in 0..size {
        let y0 = y * height / size;
        let y1 = ((y + 1) * height / size).max(y0 + 1);
        for x in 0..size {
            let x0 = x * width / size;
            let x1 = ((x + 1) * width / size).max(x0 + 1);
            let (mut r, mut g, mut b, mut a, mut n) = (0u64, 0u64, 0u64, 0u64, 0u64);
            for sy in y0..y1 {
                for sx in x0..x1 {
                    let i = ((sy * width + sx) * 4) as usize;
                    let alpha = rgba[i + 3] as u64;
                    r += rgba[i] as u64 * alpha;
                    g += rgba[i + 1] as u64 * alpha;
                    b += rgba[i + 2] as u64 * alpha;
                    a += alpha;
                    n += 1;
                }
            }
            let o = ((y * size + x) * 4) as usize;
            if a > 0 {
                out[o] = (r / a) as u8;
                out[o + 1] = (g / a) as u8;
                out[o + 2] = (b / a) as u8;
            }
            out[o + 3] = (a / n) as u8;
        }
    }
    out
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn set_platform_app_icon(_app: AppHandle, _icon_bytes: Vec<u8>) -> Result<(), String> {
    Ok(())
}

/// Локальный сервис Syne Desktop (Go). Адрес облака можно переопределить SYNE_CLOUD_SERVER.
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
        .map_err(|err| format!("failed to configure sidecar: {err}"))?
        .args(args)
        .env("SYNE_API_TOKEN", token)
        .spawn()
        .map_err(|err| format!("failed to start sidecar: {err}"))?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    println!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("[sidecar] {}", String::from_utf8_lossy(&line).trim_end())
                }
                CommandEvent::Error(err) => eprintln!("syne-desktop-api sidecar error: {err}"),
                CommandEvent::Terminated(payload) => {
                    eprintln!("syne-desktop-api sidecar terminated: {:?}", payload.code)
                }
                _ => {}
            }
        }
    });
    Ok(child)
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(BackendState {
            child: Mutex::new(None),
            token: generate_token(),
        })
        .invoke_handler(tauri::generate_handler![
            backend_url,
            backend_token,
            set_app_icon,
            open_temp_dir,
            open_with_dialog,
            get_workspace_dir,
            workspace_subdir,
            workspace_create_empty,
            workspace_file_path,
            record_workspace_file,
            workspace_diff,
            mark_workspace_uploaded,
            remove_workspace_uploaded,
            open_workspace
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let _ = std::fs::remove_dir_all(open_dir());
            let token = app.state::<BackendState>().token.clone();
            let child = spawn_backend(&handle, &token)?;
            app.state::<BackendState>()
                .child
                .lock()
                .unwrap()
                .replace(child);

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            // sidecar не должен пережить приложение: его токен действует один запуск
            if let Some(child) = app_handle
                .state::<BackendState>()
                .child
                .lock()
                .unwrap()
                .take()
            {
                let _ = child.kill();
            }
        }
    });
}
