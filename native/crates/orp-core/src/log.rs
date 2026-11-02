//! Local diagnostic log (port of logger.ts) — no telemetry, no secret.
//! `orp-core` modules never log on their own: they receive an injected `Log`,
//! silent by default, and only put public identifiers in it (token, blocks,
//! seeds, versions, sizes).

use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Value of a log context entry (string, number or boolean, like the TS).
#[derive(Debug, Clone, PartialEq)]
pub enum LogValue {
    Text(String),
    Count(f64),
    Boolean(bool),
}

impl fmt::Display for LogValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogValue::Text(t) => write!(f, "{t:?}"),
            LogValue::Count(n) => write!(f, "{n}"),
            LogValue::Boolean(b) => write!(f, "{b}"),
        }
    }
}

impl From<u32> for LogValue {
    fn from(v: u32) -> Self {
        LogValue::Count(v as f64)
    }
}
impl From<usize> for LogValue {
    fn from(v: usize) -> Self {
        LogValue::Count(v as f64)
    }
}
impl From<bool> for LogValue {
    fn from(v: bool) -> Self {
        LogValue::Boolean(v)
    }
}
impl From<&str> for LogValue {
    fn from(v: &str) -> Self {
        LogValue::Text(v.to_string())
    }
}

pub type Context<'a> = &'a [(&'a str, LogValue)];

pub trait Log {
    fn write_entry(&self, level: LogLevel, message: &str, context: Context<'_>);

    fn debug(&self, message: &str, context: Context<'_>) {
        self.write_entry(LogLevel::Debug, message, context);
    }
    fn info(&self, message: &str, context: Context<'_>) {
        self.write_entry(LogLevel::Info, message, context);
    }
    fn warn(&self, message: &str, context: Context<'_>) {
        self.write_entry(LogLevel::Warn, message, context);
    }
    fn error(&self, message: &str, context: Context<'_>) {
        self.write_entry(LogLevel::Error, message, context);
    }
}

/// The default log: silent.
pub struct SilentLog;

impl Log for SilentLog {
    fn write_entry(&self, _: LogLevel, _: &str, _: Context<'_>) {}
}

/// Log to standard error, for hosts that explicitly want it.
pub struct ConsoleLog {
    pub prefix: String,
}

impl Default for ConsoleLog {
    fn default() -> Self {
        Self { prefix: "orp".into() }
    }
}

impl Log for ConsoleLog {
    fn write_entry(&self, level: LogLevel, message: &str, context: Context<'_>) {
        let mut line = format!("{} {message}", self.prefix);
        if !context.is_empty() {
            let fields: Vec<String> = context.iter().map(|(c, v)| format!("{c:?}:{v}")).collect();
            line.push_str(&format!(" {{{}}}", fields.join(",")));
        }
        let _ = level;
        eprintln!("{line}");
    }
}
