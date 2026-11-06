//! Durable key/value journal used by the POS UI through Tauri commands.
//! Tables are logical namespaces (`orders`, `outbox`, `meta`, …) stored in one SQLite table so that a sale
//! and its outbox item commit in a single ACID transaction (see apps/pos-desktop/src/core/engine.ts).

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Deserialize;
use std::path::Path;
use std::sync::Mutex;

pub const TABLES: &[&str] = &[
    "variants", "barcodes", "prices", "promotions", "users", "taxes", "assortment", "customers",
    "orders", "outbox", "meta", "sessions", "cash_movements",
];

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("unknown table: {0}")]
    UnknownTable(String),
    #[error("put without value for key {0}")]
    MissingValue(String),
    #[error("integrity check failed: {0}")]
    Integrity(String),
}

#[derive(Debug, Clone, Deserialize)]
pub struct Op {
    pub table: String,
    pub op: String, // "put" | "delete"
    pub key: String,
    pub value: Option<String>, // JSON text
}

pub struct Store {
    conn: Mutex<Connection>,
}

fn check_table(t: &str) -> Result<(), StoreError> {
    if TABLES.contains(&t) { Ok(()) } else { Err(StoreError::UnknownTable(t.to_string())) }
}

impl Store {
    /// Open (or create) the journal. `key` enables SQLCipher when built with the `encrypted` feature.
    pub fn open(path: &Path, key: Option<&str>) -> Result<Self, StoreError> {
        let conn = Connection::open(path)?;
        if let Some(k) = key {
            // With plain SQLite this pragma is ignored; with SQLCipher it encrypts the file.
            conn.pragma_update(None, "key", k)?;
        }
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "FULL")?; // fsync on every commit: a committed sale survives power loss
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (tbl TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT (unixepoch()), PRIMARY KEY (tbl, key)) WITHOUT ROWID;",
        )?;
        let ok: String = conn.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        if ok != "ok" {
            return Err(StoreError::Integrity(ok));
        }
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn get(&self, table: &str, key: &str) -> Result<Option<String>, StoreError> {
        check_table(table)?;
        let c = self.conn.lock().expect("store mutex poisoned");
        Ok(c.query_row("SELECT value FROM kv WHERE tbl = ?1 AND key = ?2", params![table, key], |r| r.get(0)).optional()?)
    }

    /// All values of a table ordered by key (outbox keys are zero-padded sequence numbers).
    pub fn all(&self, table: &str) -> Result<Vec<String>, StoreError> {
        check_table(table)?;
        let c = self.conn.lock().expect("store mutex poisoned");
        let mut st = c.prepare_cached("SELECT value FROM kv WHERE tbl = ?1 ORDER BY key")?;
        let rows = st.query_map(params![table], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Apply all operations atomically (all-or-nothing).
    pub fn tx(&self, ops: &[Op]) -> Result<(), StoreError> {
        for o in ops {
            check_table(&o.table)?;
            if o.op == "put" && o.value.is_none() {
                return Err(StoreError::MissingValue(o.key.clone()));
            }
        }
        let mut c = self.conn.lock().expect("store mutex poisoned");
        let t = c.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for o in ops {
            match o.op.as_str() {
                "put" => { t.execute("INSERT INTO kv (tbl, key, value) VALUES (?1, ?2, ?3) ON CONFLICT (tbl, key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()", params![o.table, o.key, o.value.as_deref().unwrap()])?; }
                "delete" => { t.execute("DELETE FROM kv WHERE tbl = ?1 AND key = ?2", params![o.table, o.key])?; }
                other => return Err(StoreError::UnknownTable(format!("op {other}"))),
            }
        }
        t.commit()?;
        Ok(())
    }

    pub fn clear(&self, table: &str) -> Result<(), StoreError> {
        check_table(table)?;
        let c = self.conn.lock().expect("store mutex poisoned");
        c.execute("DELETE FROM kv WHERE tbl = ?1", params![table])?;
        Ok(())
    }

    /// Number of outbox items not yet acknowledged by the server (for the status bar / heartbeat).
    pub fn pending_outbox(&self) -> Result<i64, StoreError> {
        let c = self.conn.lock().expect("store mutex poisoned");
        Ok(c.query_row("SELECT count(*) FROM kv WHERE tbl = 'outbox' AND json_extract(value, '$.status') = 'pending'", [], |r| r.get(0))?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn put(table: &str, key: &str, v: &str) -> Op { Op { table: table.into(), op: "put".into(), key: key.into(), value: Some(v.into()) } }

    #[test]
    fn atomic_sale_and_outbox() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("pos.db"), None).unwrap();
        s.tx(&[put("orders", "o1", r#"{"id":"o1"}"#), put("outbox", "000000000001", r#"{"seq":1,"status":"pending"}"#), put("meta", "seq", r#"{"v":1}"#)]).unwrap();
        assert_eq!(s.all("outbox").unwrap().len(), 1);
        assert_eq!(s.pending_outbox().unwrap(), 1);
        // a failing op aborts the whole transaction
        let bad = [put("orders", "o2", "{}"), Op { table: "nope".into(), op: "put".into(), key: "x".into(), value: Some("{}".into()) }];
        assert!(s.tx(&bad).is_err());
        assert!(s.get("orders", "o2").unwrap().is_none());
    }

    #[test]
    fn survives_reopen_and_orders_by_key() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("pos.db");
        {
            let s = Store::open(&p, None).unwrap();
            s.tx(&[put("outbox", "000000000002", r#"{"seq":2,"status":"pending"}"#), put("outbox", "000000000001", r#"{"seq":1,"status":"acked"}"#)]).unwrap();
        } // drop = close (simulates app restart)
        let s = Store::open(&p, None).unwrap();
        let all = s.all("outbox").unwrap();
        assert!(all[0].contains("\"seq\":1") && all[1].contains("\"seq\":2"));
        assert_eq!(s.pending_outbox().unwrap(), 1);
        s.tx(&[Op { table: "outbox".into(), op: "delete".into(), key: "000000000001".into(), value: None }]).unwrap();
        assert_eq!(s.all("outbox").unwrap().len(), 1);
    }

    #[test]
    fn rejects_unknown_tables() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open(&dir.path().join("pos.db"), None).unwrap();
        assert!(matches!(s.get("users_x", "a"), Err(StoreError::UnknownTable(_))));
    }
}
