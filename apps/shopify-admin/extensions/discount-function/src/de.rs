//! Map-only `Deserialize` for the compiled config structs. serde's derive also emits a `visit_seq`
//! path, `deserialize_struct` field metadata and duplicate-field checks per struct; across the ~14 config
//! structs that cost ~25 KB of wasm. The config is always a JSON object written by the publisher,
//! so only the map path is generated. Unknown keys are ignored; the last duplicate wins.
//!
//! Field syntax: `"jsonKey" => name: Type [= default],`. No default means the field is required
//! (an offer missing it is skipped by `lenient_offers`, like the derive did).

use serde::de::{DeserializeSeed, Deserializer, Visitor};
use std::fmt;

pub struct KeySeed(pub &'static [&'static str]);

impl<'de> DeserializeSeed<'de> for KeySeed {
    type Value = usize;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<usize, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for KeySeed {
    type Value = usize;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("key")
    }
    fn visit_str<E>(self, key: &str) -> Result<usize, E> {
        Ok(self.0.iter().position(|name| *name == key).unwrap_or(usize::MAX))
    }
}

macro_rules! de_struct {
    (@missing $key:literal) => {
        return Err(<A::Error as serde::de::Error>::missing_field($key))
    };
    (@missing $key:literal, $def:expr) => {
        $def
    };
    (
        $(#[$sm:meta])*
        pub struct $name:ident {
            $( $(#[$fm:meta])* $key:literal => $field:ident : $ty:ty $(= $def:expr)?, )*
        }
    ) => {
        $(#[$sm])*
        pub struct $name {
            $( $(#[$fm])* pub $field: $ty, )*
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                #[allow(non_camel_case_types, dead_code)]
                enum F { $( $(#[$fm])* $field, )* }
                const NAMES: &[&str] = &[ $( $(#[$fm])* $key, )* ];
                struct V;
                impl<'de> serde::de::Visitor<'de> for V {
                    type Value = $name;
                    fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                        f.write_str("object")
                    }
                    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<$name, A::Error> {
                        $( $(#[$fm])* let mut $field: Option<$ty> = None; )*
                        while let Some(index) = map.next_key_seed($crate::de::KeySeed(NAMES))? {
                            $(
                                $(#[$fm])*
                                if index == F::$field as usize {
                                    $field = Some(map.next_value()?);
                                    continue;
                                }
                            )*
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                        Ok($name {
                            $( $(#[$fm])* $field: match $field {
                                Some(value) => value,
                                None => de_struct!(@missing $key $(, $def)?),
                            }, )*
                        })
                    }
                }
                deserializer.deserialize_map(V)
            }
        }
    };
}
