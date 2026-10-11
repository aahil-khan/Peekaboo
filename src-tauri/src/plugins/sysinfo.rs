//! CPU, memory and disk figures for the built-in resources plugin.

use serde_json::{json, Value};

#[tauri::command]
pub async fn plugin_system_info() -> Result<Value, String> {
    // CPU percentages are meaningless until sysinfo has two samples a short
    // interval apart, so this has to sleep — on a blocking thread, not the
    // one servicing the UI.
    tauri::async_runtime::spawn_blocking(|| {
        use sysinfo::{Disks, System};

        let mut sys = System::new();
        sys.refresh_cpu_usage();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        sys.refresh_cpu_usage();
        sys.refresh_memory();

        let cpus = sys.cpus();
        let load = System::load_average();

        // Windows reports zeroes here rather than failing, which would look
        // like an idle machine instead of an unsupported metric.
        let load_average = if cfg!(target_os = "windows") {
            Value::Null
        } else {
            json!([load.one, load.five, load.fifteen])
        };

        let mut seen = std::collections::HashSet::new();
        let disk_list = Disks::new_with_refreshed_list();
        let disks: Vec<Value> = disk_list
            .list()
            .iter()
            .filter(|d| d.total_space() > 0)
            .filter(|d| seen.insert(d.mount_point().to_path_buf()))
            .map(|d| {
                json!({
                    "mount_point": d.mount_point().to_string_lossy(),
                    "file_system": d.file_system().to_string_lossy(),
                    "total": d.total_space(),
                    "available": d.available_space(),
                })
            })
            .collect();

        json!({
            "cpu": {
                "usage": sys.global_cpu_usage(),
                "cores": cpus.len(),
                "brand": cpus.first().map(|c| c.brand().to_string()).unwrap_or_default(),
                "load_average": load_average,
            },
            "memory": {
                "total": sys.total_memory(),
                "used": sys.used_memory(),
                "swap_total": sys.total_swap(),
                "swap_used": sys.used_swap(),
            },
            "disks": disks,
        })
    })
    .await
    .map_err(|e| format!("System info task failed: {e}"))
}
