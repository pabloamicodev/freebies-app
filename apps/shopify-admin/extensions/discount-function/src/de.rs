//! Map-only `Deserialize` for the compiled config structs. serde's derive also emits a `visit_seq`
//! path, `deserialize_struct` field metadata and duplicate-field checks per struct; across the ~14 config
//! structs that cost ~25 KB of wasm. The config is always a JSON object written by the publisher,
//! so only the map path is generated. Unknown keys are ignored; the last duplicate wins.
//!
//! Field syntax: `"jsonKey" => name: Type [packed] [= default],`. `[packed]` (Vec<String> only) also accepts one
//! comma-joined string: the publisher packs lists over 100 entries because Shopify rejects input-query variables
//! with a list longer than that. No default means the field is required
//! (an offer missing it is skipped by `lenient_offers`, like the derive did).

use serde::de::{DeserializeSeed, Deserializer, Visitor};
use std::fmt;
use std::hash::{BuildHasherDefault, Hasher};

/// FNV-1a instead of the default SipHash: smaller wasm and fewer instructions. The keys are ids from the cart and the
/// config, not attacker-chosen at scale. Hash iteration order must never reach an output: it is enforced by the
/// `hash_collections_are_never_iterated` test below; ordered output goes through BTreeMap or a sorted Vec.
pub struct Fnv(u64);

impl Default for Fnv {
    fn default() -> Self {
        Fnv(0xcbf29ce484222325)
    }
}

impl Hasher for Fnv {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        let mut hash = self.0;
        for byte in bytes {
            hash = (hash ^ *byte as u64).wrapping_mul(0x100000001b3);
        }
        self.0 = hash;
    }
}

/// Stable sort without `slice::sort_by`: its driftsort/quicksort is monomorphized per element and comparator
/// (~12 KB across the Function). The merge sort here is not generic: it sorts indices through a `dyn` comparator.
pub fn sort_by<T>(items: &mut Vec<T>, mut cmp: impl FnMut(&T, &T) -> std::cmp::Ordering) {
    if items.len() < 2 {
        return;
    }
    let mut order: Vec<u32> = (0..items.len() as u32).collect();
    merge_sort(&mut order, &mut |a, b| cmp(&items[a as usize], &items[b as usize]));
    let mut slots: Vec<Option<T>> = items.drain(..).map(Some).collect();
    items.extend(order.iter().filter_map(|&index| slots[index as usize].take()));
}

fn merge_sort(order: &mut [u32], less: &mut dyn FnMut(u32, u32) -> std::cmp::Ordering) {
    let len = order.len();
    let mut merged = order.to_vec();
    let mut width = 1;
    while width < len {
        let mut start = 0;
        while start < len {
            let middle = (start + width).min(len);
            let end = (start + 2 * width).min(len);
            let (mut left, mut right) = (start, middle);
            for slot in &mut merged[start..end] {
                let take_right =
                    left == middle || (right < end && less(order[right], order[left]) == std::cmp::Ordering::Less);
                if take_right {
                    *slot = order[right];
                    right += 1;
                } else {
                    *slot = order[left];
                    left += 1;
                }
            }
            start = end;
        }
        order.copy_from_slice(&merged);
        width *= 2;
    }
}

pub type HashMap<K, V> = std::collections::HashMap<K, V, BuildHasherDefault<Fnv>>;
pub type HashSet<T> = std::collections::HashSet<T, BuildHasherDefault<Fnv>>;

/// Compact config ids are the bare numeric tail of the GID; rebuild the GID the cart lines carry.
/// A full GID (old config) passes through, so both forms are accepted.
pub fn gid(id: &mut String, kind: &str) {
    if !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()) {
        *id = format!("gid://shopify/{kind}/{id}");
    }
}

pub fn gids(ids: &mut [String], kind: &str) {
    ids.iter_mut().for_each(|id| gid(id, kind));
}

pub fn gid_opt(id: &mut Option<String>, kind: &str) {
    if let Some(id) = id {
        gid(id, kind);
    }
}

pub struct PackedList;

impl<'de> DeserializeSeed<'de> for PackedList {
    type Value = Vec<String>;
    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Vec<String>, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for PackedList {
    type Value = Vec<String>;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("list")
    }
    fn visit_str<E>(self, packed: &str) -> Result<Vec<String>, E> {
        Ok(if packed.is_empty() { Vec::new() } else { packed.split(',').map(String::from).collect() })
    }
    fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Vec<String>, A::Error> {
        let mut ids = Vec::new();
        while let Some(id) = seq.next_element()? {
            ids.push(id);
        }
        Ok(ids)
    }
}

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

// One non-inlined copy per value type instead of the deserialize + drop-old-value code at every field site.
#[inline(never)]
pub fn put<'de, A: serde::de::MapAccess<'de>, T: serde::Deserialize<'de>>(map: &mut A, slot: &mut Option<T>) -> Result<(), A::Error> {
    *slot = Some(map.next_value()?);
    Ok(())
}

#[inline(never)]
pub fn put_packed<'de, A: serde::de::MapAccess<'de>>(map: &mut A, slot: &mut Option<Vec<String>>) -> Result<(), A::Error> {
    *slot = Some(map.next_value_seed(PackedList)?);
    Ok(())
}

macro_rules! de_struct {
    (@put $map:ident $slot:ident) => {
        $crate::de::put(&mut $map, &mut $slot)?
    };
    (@put $map:ident $slot:ident $packed:ident) => {
        $crate::de::put_packed(&mut $map, &mut $slot)?
    };
    (@missing $key:literal) => {
        return Err(<A::Error as serde::de::Error>::missing_field($key))
    };
    (@missing $key:literal, $def:expr) => {
        $def
    };
    (
        $(#[$sm:meta])*
        pub struct $name:ident {
            $( $(#[$fm:meta])* $key:literal => $field:ident : $ty:ty $([$packed:ident])? $(= $def:expr)?, )*
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
                                    de_struct!(@put map $field $($packed)?);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_collections_are_never_iterated() {
        let sources = [
            ("discount_logic.rs", include_str!("discount_logic.rs")),
            ("delivery_discount_logic.rs", include_str!("delivery_discount_logic.rs")),
            ("config.rs", include_str!("config.rs")),
            ("page_match.rs", include_str!("page_match.rs")),
            ("usage.rs", include_str!("usage.rs")),
        ];
        let iterating = [".iter(", ".iter_mut(", ".values(", ".values_mut(", ".keys(", ".into_iter(", ".drain(", ".into_values(", ".into_keys("];
        for (file, source) in sources {
            let code = source.split("
#[cfg(test)]").next().unwrap();
            let mut names: Vec<&str> = Vec::new();
            for line in code.lines() {
                for marker in ["HashMap<", "HashSet<", "Usage"] {
                    let Some(position) = line.find(marker) else { continue };
                    let Some(head) = line[..position].trim_end().strip_suffix(':') else { continue };
                    let head = head.trim_end();
                    let start = head.rfind(|c: char| !(c.is_alphanumeric() || c == '_')).map_or(0, |i| i + 1);
                    if start < head.len() {
                        names.push(&head[start..]);
                    }
                }
            }
            assert!(file != "discount_logic.rs" || names.len() > 10, "name detection found {names:?}");
            let standalone = |needle: &str| {
                code.match_indices(needle).any(|(at, _)| {
                    !code[..at].ends_with(|c: char| c.is_alphanumeric() || c == '_' || c == '.')
                })
            };
            for name in names {
                for op in iterating {
                    assert!(!standalone(&format!("{name}{op}")), "{file}: `{name}{op}` iterates a hash collection");
                }
                assert!(!code.contains(&format!("in &{name} ")) && !code.contains(&format!("in {name} ")) && !code.contains(&format!("in &mut {name} ")), "{file}: `for .. in {name}` iterates a hash collection");
            }
        }
    }

    #[test]
    fn sort_by_matches_the_stable_std_sort() {
        let mut seed = 0x2545F4914F6CDD1Du64;
        for len in [0usize, 1, 2, 3, 5, 6, 7, 9, 10, 11, 31, 33, 63, 65, 100, 127, 129, 200, 257] {
            let data: Vec<(u32, usize)> = (0..len)
                .map(|index| {
                    seed ^= seed << 13;
                    seed ^= seed >> 7;
                    seed ^= seed << 17;
                    ((seed % 5) as u32, index)
                })
                .collect();
            let mut expected = data.clone();
            expected.sort_by(|a, b| a.0.cmp(&b.0));
            let mut actual = data;
            sort_by(&mut actual, |a, b| a.0.cmp(&b.0));
            assert_eq!(actual, expected, "len {len}");

            let mut expected = actual.clone();
            expected.sort_by(|a, b| b.0.cmp(&a.0));
            sort_by(&mut actual, |a, b| b.0.cmp(&a.0));
            assert_eq!(actual, expected, "reversed comparator, len {len}");

            let mut expected = actual.clone();
            expected.sort_by(|a, b| (a.0 % 2).cmp(&(b.0 % 2)).then(b.1.cmp(&a.1)));
            sort_by(&mut actual, |a, b| (a.0 % 2).cmp(&(b.0 % 2)).then(b.1.cmp(&a.1)));
            assert_eq!(actual, expected, "compound comparator, len {len}");
        }
    }

    #[test]
    fn fnv_maps_and_sets_behave_like_std_ones() {
        let mut map: HashMap<String, i64> = HashMap::default();
        for index in 0..500 {
            *map.entry(format!("key-{}", index % 50)).or_default() += index;
        }
        assert_eq!(map.len(), 50);
        assert_eq!(map["key-7"], (0..500).filter(|i| i % 50 == 7).sum::<i64>());
        let set: HashSet<&str> = ["a", "b", "a"].into_iter().collect();
        assert_eq!(set.len(), 2);
        assert!(set.contains("b") && !set.contains("c"));
    }
}
