use serde_json::{json, Value};
use std::process::Stdio;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

const API: &str = "https://flathub.org/api/v2";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent("flatstore/0.1")
        .build()
        .map_err(|e| e.to_string())
}

fn spawn_err(e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        "Flatpak is not installed".into()
    } else {
        e.to_string()
    }
}

fn which(bin: &str) -> bool {
    std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).any(|d| d.join(bin).is_file()))
        .unwrap_or(false)
}

fn valid_app_id(id: &str) -> bool {
    !id.is_empty()
        && !id.starts_with('-')
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// Reads a stream, emitting each line (split on \r and \n) as a "flatpak-progress" event.
async fn read_lines<R: AsyncReadExt + Unpin>(app: AppHandle, tag: String, mut r: R) -> String {
    let mut all = String::new();
    let mut buf = [0u8; 2048];
    loop {
        let n = match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        let chunk = String::from_utf8_lossy(&buf[..n]).into_owned();
        all.push_str(&chunk);
        for line in chunk.split(|c| c == '\r' || c == '\n') {
            let line = line.trim();
            if !line.is_empty() {
                let _ = app.emit("flatpak-progress", json!({ "app_id": tag, "line": line }));
            }
        }
    }
    all
}

/// Runs a command, streaming its output as progress events tagged with `tag`.
async fn run_streamed(app: &AppHandle, mut cmd: Command, tag: &str) -> Result<(), String> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(spawn_err)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();

    let (a2, t2) = (app.clone(), tag.to_string());
    let err_task = tauri::async_runtime::spawn(async move { read_lines(a2, t2, stderr).await });
    let _ = read_lines(app.clone(), tag.to_string(), stdout).await;
    let err = err_task.await.unwrap_or_default();

    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else if err.trim().is_empty() {
        Err(format!("Command failed ({status}). It may have been cancelled."))
    } else {
        Err(err)
    }
}

/// GET on the Flathub API (e.g. "/collection/popular", "/appstream/org.mozilla.firefox")
#[tauri::command]
async fn api_get(path: String) -> Result<Value, String> {
    if !path.starts_with('/') || path.contains("..") {
        return Err("Invalid path".into());
    }
    let res = client()?
        .get(format!("{API}{path}"))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Flathub returned {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

/// Text search
#[tauri::command]
async fn api_search(query: String) -> Result<Value, String> {
    let res = client()?
        .post(format!("{API}/search"))
        .json(&json!({ "query": query }))
        .send()
        .await
        .map_err(|e| format!("Network error: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Flathub returned {}", res.status()));
    }
    res.json::<Value>().await.map_err(|e| e.to_string())
}

/// Is the flatpak CLI available?
#[tauri::command]
fn flatpak_available() -> bool {
    which("flatpak")
}

/// Installs Flatpak with the distro's package manager (asks for the password via polkit)
#[tauri::command]
async fn install_flatpak(app: AppHandle) -> Result<(), String> {
    if which("flatpak") {
        return Ok(());
    }
    if !which("pkexec") {
        return Err("pkexec (polkit) was not found. Install Flatpak manually: https://flatpak.org/setup".into());
    }
    let (bin, args): (&str, Vec<&str>) = if which("pacman") {
        ("pacman", vec!["-S", "--noconfirm", "--needed", "flatpak"])
    } else if which("apt-get") {
        ("sh", vec!["-c", "DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y flatpak"])
    } else if which("dnf") {
        ("dnf", vec!["install", "-y", "flatpak"])
    } else if which("zypper") {
        ("zypper", vec!["--non-interactive", "install", "flatpak"])
    } else if which("xbps-install") {
        ("xbps-install", vec!["-Sy", "flatpak"])
    } else {
        return Err("Unsupported distro. Install Flatpak manually: https://flatpak.org/setup".into());
    };

    let mut cmd = Command::new("pkexec");
    cmd.arg(bin).args(&args);
    run_streamed(&app, cmd, "__flatpak__").await?;

    if which("flatpak") {
        Ok(())
    } else {
        Err("Installation finished but flatpak was not found in PATH".into())
    }
}

/// Makes sure the "flathub" remote exists (user scope, no root needed)
#[tauri::command]
async fn ensure_flathub() -> Result<(), String> {
    let out = Command::new("flatpak")
        .args([
            "remote-add", "--user", "--if-not-exists", "flathub",
            "https://dl.flathub.org/repo/flathub.flatpakrepo",
        ])
        .output()
        .await
        .map_err(spawn_err)?;
    if out.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

/// IDs of installed apps (user and system installations)
#[tauri::command]
async fn installed_apps() -> Result<Vec<String>, String> {
    let out = match Command::new("flatpak")
        .args(["list", "--app", "--columns=application"])
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    Ok(String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect())
}

/// Installs / removes / updates an app, streaming progress via "flatpak-progress"
#[tauri::command]
async fn flatpak_run(app: AppHandle, action: String, app_id: String) -> Result<(), String> {
    if !valid_app_id(&app_id) {
        return Err("Invalid app ID".into());
    }
    let args: Vec<&str> = match action.as_str() {
        "install" => vec!["install", "--user", "-y", "--noninteractive", "flathub", &app_id],
        "uninstall" => vec!["uninstall", "-y", "--noninteractive", &app_id],
        "update" => vec!["update", "-y", "--noninteractive", &app_id],
        _ => return Err("Invalid action".into()),
    };
    let mut cmd = Command::new("flatpak");
    cmd.args(&args);
    run_streamed(&app, cmd, &app_id).await
}

/// Launches an installed app
#[tauri::command]
async fn launch_app(app_id: String) -> Result<(), String> {
    if !valid_app_id(&app_id) {
        return Err("Invalid app ID".into());
    }
    Command::new("flatpak")
        .args(["run", &app_id])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(spawn_err)?;
    Ok(())
}

/// Opens an https link in the default browser
#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    Command::new("xdg-open")
        .arg(&url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            api_get,
            api_search,
            flatpak_available,
            install_flatpak,
            ensure_flathub,
            installed_apps,
            flatpak_run,
            launch_app,
            open_url
        ])
        .run(tauri::generate_context!())
        .expect("error while starting FlatStore");
}
