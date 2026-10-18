//! `tildone-axi call <tool> --flag value`: flags are built from the tool's own
//! inputSchema, so a new server tool needs no CLI change. Nested values go through
//! `--json` (an object, or `-` for stdin).

use serde_json::{json, Map, Value};

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Str,
    Int,
    Num,
    Bool,
    StrList,
    /// A task id (number) or ref ("TIL-3"): numeric text becomes a number.
    TaskRef,
    /// An object or other shape a flag cannot carry.
    Nested,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Str => "string",
            Kind::Int => "integer",
            Kind::Num => "number",
            Kind::Bool => "boolean",
            Kind::StrList => "string,...",
            Kind::TaskRef => "id-or-ref",
            Kind::Nested => "json",
        }
    }
}

pub struct Prop {
    pub name: String,
    pub kind: Kind,
    pub required: bool,
    pub about: String,
}

impl Prop {
    pub fn flag(&self) -> String {
        self.name.replace('_', "-")
    }
}

/// The tool's properties, in schema order, with each type reduced to a `Kind`.
pub fn props(schema: &Map<String, Value>) -> Vec<Prop> {
    let defs = schema
        .get("$defs")
        .or_else(|| schema.get("definitions"))
        .cloned()
        .unwrap_or(json!({}));
    let required: Vec<&str> = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    let Some(Value::Object(properties)) = schema.get("properties") else {
        return Vec::new();
    };
    properties
        .iter()
        .map(|(name, s)| Prop {
            name: name.clone(),
            kind: kind_of(s, &defs),
            required: required.contains(&name.as_str()),
            about: s
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        })
        .collect()
}

fn kind_of(schema: &Value, defs: &Value) -> Kind {
    if let Some(r) = schema.get("$ref").and_then(Value::as_str) {
        let name = r.rsplit('/').next().unwrap_or_default();
        return defs.get(name).map_or(Kind::Nested, |d| kind_of(d, defs));
    }
    for key in ["anyOf", "oneOf"] {
        if let Some(Value::Array(options)) = schema.get(key) {
            let kinds: Vec<Kind> = options
                .iter()
                .filter(|o| o.get("type").and_then(Value::as_str) != Some("null"))
                .map(|o| kind_of(o, defs))
                .collect();
            return match kinds.as_slice() {
                [one] => *one,
                many if many.contains(&Kind::Int)
                    && many.contains(&Kind::Str)
                    && many.len() == 2 =>
                {
                    Kind::TaskRef
                }
                _ => Kind::Nested,
            };
        }
    }
    let types: Vec<&str> = match schema.get("type") {
        Some(Value::String(t)) => vec![t.as_str()],
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(Value::as_str)
            .filter(|t| *t != "null")
            .collect(),
        _ => Vec::new(),
    };
    match types.as_slice() {
        ["string"] => Kind::Str,
        ["integer"] => Kind::Int,
        ["number"] => Kind::Num,
        ["boolean"] => Kind::Bool,
        ["array"] => match schema.get("items").map(|i| kind_of(i, defs)) {
            Some(Kind::Str) => Kind::StrList,
            _ => Kind::Nested,
        },
        _ => Kind::Nested,
    }
}

/// Builds the call arguments from the tokens after the tool name. `stdin` is only
/// read for `--json -`.
pub fn parse(
    props: &[Prop],
    tokens: &[String],
    stdin: impl FnOnce() -> String,
) -> Result<Map<String, Value>, String> {
    let find = |name: &str| props.iter().find(|p| p.flag() == name || p.name == name);
    let mut args = Map::new();
    let mut json_base = Map::new();
    let mut stdin = Some(stdin);
    let mut it = tokens.iter();
    while let Some(tok) = it.next() {
        let Some(flag) = tok.strip_prefix("--") else {
            return Err(format!(
                "unexpected argument `{tok}`; flags look like --{}",
                props.first().map_or("name".into(), Prop::flag)
            ));
        };
        let (name, inline) = match flag.split_once('=') {
            Some((n, v)) => (n, Some(v.to_string())),
            None => (flag, None),
        };
        if name == "json" {
            let raw = match inline.or_else(|| it.next().cloned()) {
                Some(v) if v == "-" => stdin.take().map(|f| f()).unwrap_or_default(),
                Some(v) => v,
                None => return Err("--json needs an object, or `-` to read stdin".into()),
            };
            match serde_json::from_str::<Value>(&raw) {
                Ok(Value::Object(o)) => json_base.extend(o),
                Ok(_) => return Err("--json must be a JSON object".into()),
                Err(e) => return Err(format!("--json is not valid JSON: {e}")),
            }
            continue;
        }
        if let Some(neg) = name.strip_prefix("no-") {
            if let Some(p) = find(neg).filter(|p| p.kind == Kind::Bool) {
                args.insert(p.name.clone(), Value::Bool(false));
                continue;
            }
        }
        let Some(p) = find(name) else {
            let known: Vec<String> = props.iter().map(|p| format!("--{}", p.flag())).collect();
            return Err(format!(
                "unknown flag --{name}; this tool takes {} and --json",
                known.join(" ")
            ));
        };
        if p.kind == Kind::Bool {
            let v = match inline.as_deref() {
                None | Some("true") => true,
                Some("false") => false,
                Some(other) => {
                    return Err(format!("--{} is a boolean flag, not `{other}`", p.flag()))
                }
            };
            args.insert(p.name.clone(), Value::Bool(v));
            continue;
        }
        let Some(raw) = inline.or_else(|| it.next().cloned()) else {
            return Err(format!("--{} needs a value ({})", p.flag(), p.kind.label()));
        };
        let value = match p.kind {
            Kind::Str => Value::String(raw),
            Kind::Int => Value::from(
                raw.parse::<i64>()
                    .map_err(|_| format!("--{} needs an integer, got `{raw}`", p.flag()))?,
            ),
            Kind::Num => Value::from(
                raw.parse::<f64>()
                    .map_err(|_| format!("--{} needs a number, got `{raw}`", p.flag()))?,
            ),
            Kind::TaskRef => task_ref(&raw),
            Kind::StrList => {
                let mut list = match args.remove(&p.name) {
                    Some(Value::Array(a)) => a,
                    _ => Vec::new(),
                };
                list.extend(
                    raw.split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(Value::from),
                );
                Value::Array(list)
            }
            Kind::Nested => {
                return Err(format!(
                    "--{} takes a nested value; pass it with --json",
                    p.flag()
                ))
            }
            Kind::Bool => unreachable!(),
        };
        args.insert(p.name.clone(), value);
    }
    // Explicit flags win over the --json base.
    let mut merged = json_base;
    merged.extend(args);
    for p in props.iter().filter(|p| p.required) {
        if !merged.contains_key(&p.name) {
            return Err(format!(
                "missing required --{} ({})",
                p.flag(),
                p.kind.label()
            ));
        }
    }
    Ok(merged)
}

/// "42" is the task with id 42; anything else is a ref like "TIL-3".
pub fn task_ref(s: &str) -> Value {
    s.parse::<i64>()
        .map_or_else(|_| Value::String(s.to_string()), Value::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> Map<String, Value> {
        let Value::Object(m) = json!({
            "$defs": {"TaskRef": {"anyOf": [{"type": "integer"}, {"type": "string"}]}},
            "properties": {
                "id": {"$ref": "#/$defs/TaskRef"},
                "from_task": {"anyOf": [{"$ref": "#/$defs/TaskRef"}, {"type": "null"}]},
                "title": {"type": ["string", "null"]},
                "priority": {"type": ["integer", "null"]},
                "include_done": {"type": ["boolean", "null"]},
                "tags": {"type": ["array", "null"], "items": {"type": "string"}},
                "options": {"type": "object"}
            },
            "required": ["id"]
        }) else {
            unreachable!()
        };
        m
    }

    fn run(tokens: &[&str]) -> Result<Map<String, Value>, String> {
        let t: Vec<String> = tokens.iter().map(|s| s.to_string()).collect();
        parse(&props(&schema()), &t, || {
            r#"{"title":"from stdin","priority":1}"#.into()
        })
    }

    #[test]
    fn kinds_come_from_the_schema() {
        let kinds: Vec<Kind> = props(&schema()).iter().map(|p| p.kind).collect();
        assert_eq!(
            kinds,
            [
                Kind::TaskRef,
                Kind::TaskRef,
                Kind::Str,
                Kind::Int,
                Kind::Bool,
                Kind::StrList,
                Kind::Nested
            ]
        );
    }

    #[test]
    fn parses_flag_value_shapes() {
        // A value may start with a hyphen, and --flag=value works inline.
        let a = run(&["--id", "TIL-3", "--from-task=7", "--title", "-x"]).unwrap();
        assert_eq!(
            Value::Object(a),
            json!({"id": "TIL-3", "from_task": 7, "title": "-x"})
        );
    }

    #[test]
    fn rejects_bad_input() {
        assert!(run(&["--title", "t"])
            .unwrap_err()
            .contains("missing required --id"));
        assert!(run(&["--id", "1", "--nope", "x"])
            .unwrap_err()
            .contains("unknown flag"));
    }
}
