//! A tiny TOON encoder for the two shapes this CLI prints: a uniform table
//! (`name[N]{a,b}:` plus indented rows) and flat `key: value` lines. Values follow
//! TOON's quoting rules so an agent can parse every line back unambiguously.

use serde_json::Value;

/// A string as it appears in a table cell or after `key: `: bare when safe,
/// otherwise quoted with `"`, `\` and control characters escaped.
pub fn string(s: &str) -> String {
    if !needs_quotes(s) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() || matches!(c, '\u{2028}' | '\u{2029}') => {
                out.push_str(&format!("\\u{:04X}", c as u32))
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn needs_quotes(s: &str) -> bool {
    s.is_empty()
        || s != s.trim()
        || matches!(s, "true" | "false" | "null")
        || looks_numeric(s)
        || s.starts_with('-')
        || s.chars().any(|c| {
            matches!(c, ',' | ':' | '"' | '\\' | '[' | ']' | '{' | '}')
                || c.is_control()
                || matches!(c, '\u{2028}' | '\u{2029}')
        })
}

/// True when a parser would read the text as a number (`42`, `-1.5`, `1e3`, `007`).
fn looks_numeric(s: &str) -> bool {
    // Rust's f64 parser also accepts "inf" and "nan"; TOON does not.
    s.chars()
        .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
        && s.chars().any(|c| c.is_ascii_digit())
        && (s.parse::<f64>().is_ok()
            || (s.starts_with('0') && s.chars().all(|c| c.is_ascii_digit())))
}

/// A JSON value as one TOON token. Arrays are joined with commas and then quoted;
/// null is an empty string, the way a missing column is.
pub fn value(v: &Value) -> String {
    match v {
        Value::Null => string(""),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => string(s),
        Value::Array(items) => string(
            &items
                .iter()
                .map(|i| match i {
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                })
                .collect::<Vec<_>>()
                .join(","),
        ),
        Value::Object(_) => string(&v.to_string()),
    }
}

/// `key: value`, with the key quoted only when it is not a plain identifier.
pub fn kv(key: &str, v: &Value) -> String {
    format!("{}: {}", key_token(key), value(v))
}

fn key_token(key: &str) -> String {
    let plain = key
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.'));
    if plain {
        key.to_string()
    } else {
        format!("\"{}\"", key.replace('\\', "\\\\").replace('"', "\\\""))
    }
}

/// `name[N]{a,b,c}:` then one indented row per item. Every row carries every
/// column: a missing field is an empty string.
pub fn table(name: &str, cols: &[&str], items: &[Value]) -> String {
    let mut out = format!("{name}[{}]{{{}}}:", items.len(), cols.join(","));
    for item in items {
        let row: Vec<String> = cols
            .iter()
            .map(|c| item.get(*c).map_or_else(|| string(""), value))
            .collect();
        out.push_str("\n  ");
        out.push_str(&row.join(","));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn quotes_what_would_misparse() {
        assert_eq!(string("plain words"), "plain words");
        assert_eq!(string("follow-up"), "follow-up");
        assert_eq!(string("TIL-230"), "TIL-230");
        for s in [
            "",
            " pad",
            "pad ",
            "a,b",
            "a: b",
            "say \"hi\"",
            "back\\slash",
            "[x]",
            "{x}",
            "true",
            "null",
            "42",
            "-1.5",
            "1e3",
            "007",
            "-lead",
        ] {
            assert!(
                string(s).starts_with('"'),
                "{s:?} must be quoted, got {}",
                string(s)
            );
        }
        assert_eq!(string("inf"), "inf");
        // Control characters other than \n \r \t are escaped, never left raw in the quotes.
        assert_eq!(
            string("a\u{b}b\u{c}c\u{85}d\u{2028}e\u{2029}f\u{7f}"),
            "\"a\\u000Bb\\u000Cc\\u0085d\\u2028e\\u2029f\\u007F\""
        );
        assert_eq!(
            string("two\nlines \"q\" \\"),
            "\"two\\nlines \\\"q\\\" \\\\\""
        );
    }

    #[test]
    fn table_fills_missing_columns() {
        let rows = [
            json!({"ref": "TIL-1", "title": "A, B"}),
            json!({"ref": "TIL-2", "tags": ["x", "y"]}),
        ];
        assert_eq!(
            table("tasks", &["ref", "title", "tags"], &rows),
            "tasks[2]{ref,title,tags}:\n  TIL-1,\"A, B\",\"\"\n  TIL-2,\"\",\"x,y\""
        );
    }
}
