//! Tauri commands over the platform facade. Keep these one-liners: any logic
//! belongs in the capability file so it is shared by every caller.

use tauri::AppHandle;

#[tauri::command]
pub fn plugin_get_selection() -> Option<String> {
    super::read_selection().ok().flatten()
}

#[tauri::command]
pub fn selection_capture_info() -> super::CaptureInfo {
    super::capture_info()
}

#[tauri::command]
pub fn get_active_window() -> Result<serde_json::Value, String> {
    super::active_window()
}

#[tauri::command]
pub async fn capture_region(app: AppHandle) -> Result<String, String> {
    super::capture_region(app).await
}

#[tauri::command]
pub async fn paste_result(app: AppHandle, text: String) -> Result<super::PasteOutcome, String> {
    super::paste_result(app, text).await
}

#[tauri::command]
pub async fn type_text(app: AppHandle, text: String) -> Result<super::PasteOutcome, String> {
    super::type_text(app, text).await
}
