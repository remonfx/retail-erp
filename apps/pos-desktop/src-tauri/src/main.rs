// RetailCore POS desktop shell.
// - Durable journal: pos-store (SQLite WAL + synchronous=FULL, SQLCipher-encrypted; key in the OS keystore).
// - Hardware: ESC/POS receipt printing over raw TCP (port 9100) and cash-drawer kick pulse.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use pos_store::{Op, Store};
use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;
use tauri::{Manager, State};

fn db_key() -> Result<String, String> {
    let entry = keyring::Entry::new("retailcore-pos", "local-db-key").map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(k) => Ok(k),
        Err(_) => {
            let k: [u8; 32] = rand::random();
            let k = hex::encode(k);
            entry.set_password(&k).map_err(|e| e.to_string())?;
            Ok(k)
        }
    }
}

#[tauri::command]
fn kv_get(store: State<Store>, table: String, key: String) -> Result<Option<String>, String> { store.get(&table, &key).map_err(|e| e.to_string()) }
#[tauri::command]
fn kv_all(store: State<Store>, table: String) -> Result<Vec<String>, String> { store.all(&table).map_err(|e| e.to_string()) }
#[tauri::command]
fn kv_tx(store: State<Store>, ops: Vec<Op>) -> Result<(), String> { store.tx(&ops).map_err(|e| e.to_string()) }
#[tauri::command]
fn kv_clear(store: State<Store>, table: String) -> Result<(), String> { store.clear(&table).map_err(|e| e.to_string()) }

/// Send raw ESC/POS bytes (prepared by the UI: Arabic text rendered as raster image) to a network printer.
#[tauri::command]
fn print_raw(host: String, port: Option<u16>, bytes: Vec<u8>, open_drawer: bool) -> Result<(), String> {
    let addr = format!("{}:{}", host, port.unwrap_or(9100));
    let mut s = TcpStream::connect_timeout(&addr.parse().map_err(|e| format!("{e}"))?, Duration::from_secs(3)).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(Duration::from_secs(5))).ok();
    s.write_all(&[0x1b, 0x40]).map_err(|e| e.to_string())?; // ESC @ initialize
    s.write_all(&bytes).map_err(|e| e.to_string())?;
    s.write_all(&[0x1d, 0x56, 0x42, 0x00]).map_err(|e| e.to_string())?; // GS V B 0: partial cut
    if open_drawer { s.write_all(&[0x1b, 0x70, 0x00, 0x19, 0xfa]).map_err(|e| e.to_string())?; } // ESC p 0: drawer kick
    s.flush().map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let key = db_key().map_err(|e| Box::<dyn std::error::Error>::from(e))?;
            let store = Store::open(&dir.join("pos-journal.db"), Some(&key)).map_err(|e| Box::<dyn std::error::Error>::from(e.to_string()))?;
            app.manage(store);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![kv_get, kv_all, kv_tx, kv_clear, print_raw])
        .run(tauri::generate_context!())
        .expect("error while running RetailCore POS");
}
