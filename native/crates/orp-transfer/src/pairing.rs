//! Pairing frames (packages/browser/src/tm.ts).

use orp_core::pairing::{pairing_code_kind, PairingCodeKind};
use orp_core::{read_frame, RandomSource, SystemRandom, FLAG_PAIRING};

/// Alphabet of the 12-character codes shown by OptiRelay Studio, the
/// Secure Hello world example and this app (no 0/O, 1/I/L): 31 symbols,
/// 12 characters ≈ 59 bits.
pub const CODE_ALPHABET: &str = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const CODE_LENGTH: usize = 12;

/// A sender's pairing code, drawn UNIFORMLY from the system CSPRNG
/// (rejection sampling, like `randomCode` of examples/studio): it is the
/// passphrase of the pairing (`PairingMode::Passphrase`), shown as TEXT
/// next to the grid — never inside it — and typed on the receiver.
pub fn random_code() -> String {
    random_code_from(&mut SystemRandom)
}

/// Same draw from a given source (tests: reproducible stream).
pub fn random_code_from(source: &mut dyn RandomSource) -> String {
    let alphabet = CODE_ALPHABET.as_bytes();
    // Largest multiple of 31 below 256: the bytes beyond are rejected,
    // otherwise the first symbols would come out more often.
    let limit = 256 - (256 % alphabet.len());
    let mut code = String::with_capacity(CODE_LENGTH);
    let mut buffer = [0u8; 32];
    while code.len() < CODE_LENGTH {
        source.fill(&mut buffer);
        for &b in &buffer {
            if (b as usize) < limit && code.len() < CODE_LENGTH {
                code.push(alphabet[b as usize % alphabet.len()] as char);
            }
        }
    }
    code
}

/// The code as shown to the eyes: "K7QF-M2XP-9CHR".
pub fn shown_code(code: &str) -> String {
    let chars: Vec<char> = code.chars().collect();
    chars.chunks(4).map(|c| c.iter().collect::<String>()).collect::<Vec<_>>().join("-")
}

/// The verification code (SAS) as shown: "123 456".
pub fn shown_sas(sas: &str) -> String {
    let cut = sas.len().min(3);
    format!("{} {}", &sas[..cut], &sas[cut..])
}

/// Passphrase from what the user TYPED (same rule as the PWA, apps/web
/// `typedPassphrase`): a sender's code, shown grouped for the eyes
/// ("K7QF-M2XP-9CHR"), has the code itself as passphrase — upper case,
/// without separators. Typed with dashes, spaces or in lower case, such a
/// code is brought back to that form; any other passphrase is kept as typed
/// (trimmed).
/// The code field AS THE USER TYPES: upper case, only the characters a code
/// can hold, at most 12, a dash after the 4th and the 8th — "k7qfm2" becomes
/// "K7QF-M2". Typed dashes and spaces are dropped (then put back where they
/// belong), so deleting over a dash just works.
pub fn code_as_typed(typed: &str) -> String {
    let mut out = String::with_capacity(CODE_LENGTH + 2);
    let mut count = 0;
    for c in typed.chars().flat_map(char::to_uppercase) {
        if count == CODE_LENGTH {
            break;
        }
        if !c.is_ascii_alphanumeric() {
            continue;
        }
        if count == 4 || count == 8 {
            out.push('-');
        }
        out.push(c);
        count += 1;
    }
    out
}

pub fn typed_passphrase(typed: &str) -> String {
    let passphrase = typed.trim();
    let code: String = passphrase.chars().filter(|c| !c.is_whitespace() && *c != '-').collect::<String>().to_uppercase();
    if code.chars().count() == CODE_LENGTH && code.chars().all(|c| CODE_ALPHABET.contains(c)) {
        code
    } else {
        passphrase.to_string()
    }
}

#[cfg(test)]
mod code_as_typed_tests {
    use super::{code_as_typed, typed_passphrase};

    #[test]
    fn dashes_come_by_themselves() {
        assert_eq!(code_as_typed(""), "");
        assert_eq!(code_as_typed("k7q"), "K7Q");
        assert_eq!(code_as_typed("k7qf"), "K7QF");
        assert_eq!(code_as_typed("k7qfm"), "K7QF-M");
        assert_eq!(code_as_typed("K7QF-M2XP9"), "K7QF-M2XP-9");
        // Backspace over the dash: "K7QF-" → "K7QF".
        assert_eq!(code_as_typed("K7QF-"), "K7QF");
        // Pasted grouped, with spaces, too long: cut at 12 characters.
        assert_eq!(code_as_typed(" k7qf m2xp 9chr zz"), "K7QF-M2XP-9CHR");
        // The formatted code is the passphrase of the sender.
        assert_eq!(typed_passphrase(&code_as_typed("k7qfm2xp9chr")), "K7QFM2XP9CHR");
    }
}

#[cfg(test)]
mod typed_passphrase_tests {
    use super::*;

    #[test]
    fn a_drawn_code_has_the_alphabet_and_the_length() {
        for _ in 0..200 {
            let code = random_code();
            assert_eq!(code.chars().count(), CODE_LENGTH, "{code}");
            assert!(code.chars().all(|c| CODE_ALPHABET.contains(c)), "{code}");
            // Typed back as shown (grouped, lower case): the same passphrase.
            assert_eq!(typed_passphrase(&shown_code(&code).to_lowercase()), code);
        }
        // Two draws differ (59 bits).
        assert_ne!(random_code(), random_code());
        assert_eq!(shown_code("K7QFM2XP9CHR"), "K7QF-M2XP-9CHR");
        assert_eq!(shown_sas("123456"), "123 456");
    }

    #[test]
    fn the_draw_is_uniform() {
        // Reproducible stream: every symbol of the alphabet comes out, none
        // much more often than the others (rejection, no modulo bias).
        let mut source = orp_core::MulberryRandom::new(7);
        let mut counts = std::collections::HashMap::new();
        for _ in 0..2000 {
            for c in random_code_from(&mut source).chars() {
                *counts.entry(c).or_insert(0usize) += 1;
            }
        }
        assert_eq!(counts.len(), CODE_ALPHABET.len());
        let expected = 2000.0 * CODE_LENGTH as f64 / CODE_ALPHABET.len() as f64;
        assert!(counts.values().all(|&n| (n as f64 - expected).abs() < 0.15 * expected), "{counts:?}");
    }

    #[test]
    fn a_shown_code_comes_back_to_its_passphrase() {
        assert_eq!(typed_passphrase("k7qf-m2xp-9chr"), "K7QFM2XP9CHR");
        assert_eq!(typed_passphrase(" K7QF M2XP 9CHR "), "K7QFM2XP9CHR");
        assert_eq!(typed_passphrase("K7QFM2XP9CHR"), "K7QFM2XP9CHR");
    }

    #[test]
    fn any_other_passphrase_is_kept() {
        assert_eq!(typed_passphrase("  optirelay-banc "), "optirelay-banc");
        assert_eq!(typed_passphrase("mont-blanc-2026"), "mont-blanc-2026");
        // 12 characters, but outside the code alphabet (O, I, L): kept.
        assert_eq!(typed_passphrase("hello-world-io"), "hello-world-io");
    }
}

/// Payload of a pairing frame that was read (truncated to `size`), or None.
pub fn pairing_payload(bytes: &[u8], size: usize) -> Option<Vec<u8>> {
    let parsed = read_frame(bytes).ok()?;
    if parsed.header.flags & FLAG_PAIRING == 0 {
        return None;
    }
    Some(parsed.payload[..size.min(parsed.payload.len())].to_vec())
}

/// The pairing code carried by a frame, with its kind (first byte, ORP
/// v0.2): an init or reveal code on the sender's screen, a response code on
/// the receiver's. The payload is cut to the size of that kind (the frame
/// pads it to whole symbols, and an init frame may carry the sending state
/// after the code). None: not a pairing frame, or a code of unknown kind.
pub fn pairing_code(bytes: &[u8]) -> Option<(PairingCodeKind, Vec<u8>)> {
    let parsed = read_frame(bytes).ok()?;
    if parsed.header.flags & FLAG_PAIRING == 0 {
        return None;
    }
    let kind = pairing_code_kind(&parsed.payload)?;
    let size = kind.size();
    (parsed.payload.len() >= size).then(|| (kind, parsed.payload[..size].to_vec()))
}

pub fn is_pairing_frame(bytes: &[u8]) -> bool {
    read_frame(bytes).map(|l| l.header.flags & FLAG_PAIRING != 0).unwrap_or(false)
}
