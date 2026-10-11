//! Tauri commands over the platform facade. Keep these one-liners: any logic
//! belongs in the capability file so it is shared by every caller.

use tauri::AppHandle;

#[tauri::command]
pub fn plugin_get_selection() -> Option<String> {
    super::selection()
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
pub fn type_text(text: String) -> Result<(), String> {
    super::type_text(&text)
}
