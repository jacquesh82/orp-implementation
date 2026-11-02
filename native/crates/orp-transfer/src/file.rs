//! Packing of a transferred file: "ORF1", name, MIME type, bytes
//! (packages/browser/src/file.ts, pack / unpack).

const MAGIC: [u8; 4] = [0x4f, 0x52, 0x46, 0x31]; // "ORF1"

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransferredFile {
    pub name: String,
    pub mime_type: String,
    pub data: Vec<u8>,
}

/// Truncates a string to at most `n` UTF-16 units, like `String.slice` in JS.
fn truncate_utf16(s: &str, n: usize) -> &str {
    let mut units = 0;
    for (i, c) in s.char_indices() {
        units += c.len_utf16();
        if units > n {
            return &s[..i];
        }
    }
    s
}

pub fn pack(f: &TransferredFile) -> Vec<u8> {
    let n = truncate_utf16(&f.name, 200).as_bytes();
    let mime_type = if f.mime_type.is_empty() { "application/octet-stream" } else { &f.mime_type };
    let t = truncate_utf16(mime_type, 100).as_bytes();
    let mut output = Vec::with_capacity(8 + n.len() + t.len() + f.data.len());
    output.extend_from_slice(&MAGIC);
    output.extend_from_slice(&(n.len() as u16).to_be_bytes());
    output.extend_from_slice(n);
    output.extend_from_slice(&(t.len() as u16).to_be_bytes());
    output.extend_from_slice(t);
    output.extend_from_slice(&f.data);
    output
}

pub fn unpack(bytes: &[u8]) -> TransferredFile {
    let raw = || TransferredFile { name: "optirelay-received.bin".into(), mime_type: "application/octet-stream".into(), data: bytes.to_vec() };
    if bytes.len() < 8 || bytes[..4] != MAGIC {
        return raw();
    }
    let ln = u16::from_be_bytes([bytes[4], bytes[5]]) as usize;
    let Some(name) = bytes.get(6..6 + ln).and_then(|b| std::str::from_utf8(b).ok()) else { return raw() };
    let Some(lt) = bytes.get(6 + ln..8 + ln).map(|b| u16::from_be_bytes([b[0], b[1]]) as usize) else { return raw() };
    let Some(mime_type) = bytes.get(8 + ln..8 + ln + lt).and_then(|b| std::str::from_utf8(b).ok()) else { return raw() };
    // Name offered when saving: never a path nor a control character.
    let name_on: String = name.chars().map(|c| if "\\/:*?\"<>|".contains(c) || (c as u32) < 0x20 { '_' } else { c }).collect();
    let name_on = name_on.trim();
    TransferredFile {
        name: if name_on.is_empty() { "optirelay-received.bin".into() } else { name_on.into() },
        mime_type: if mime_type.is_empty() { "application/octet-stream".into() } else { mime_type.into() },
        data: bytes[8 + ln + lt..].to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_sanitized_name() {
        let f = TransferredFile { name: "a/b:c.jpg".into(), mime_type: "image/jpeg".into(), data: vec![1, 2, 3] };
        let e = pack(&f);
        assert_eq!(&e[..4], b"ORF1");
        let d = unpack(&e);
        assert_eq!(d.name, "a_b_c.jpg");
        assert_eq!(d.mime_type, "image/jpeg");
        assert_eq!(d.data, vec![1, 2, 3]);
        assert_eq!(unpack(&[9, 9]).name, "optirelay-received.bin");
    }
}
