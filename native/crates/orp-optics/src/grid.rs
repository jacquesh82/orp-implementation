//! Geometry of the ORP v0.1 grid — frozen by docs/orp-protocol-v0.1.md §9.
//!
//! N=41 modules per side. PURE BLACK AND WHITE structure: three 7×7 finder
//! markers (top-left, top-right, bottom-left), white separators, alternating
//! timing lines (row 6, column 6) and a ring of color pilots (the 8 colors of
//! the palette in a fixed order, twice).

use std::sync::LazyLock;

use orp_core::Codec;

use crate::palettes::{bits_per_module, palette_for};

pub const GRID_SIZE: usize = 41;
pub const MARKER_SIZE: usize = 7;
const N: usize = GRID_SIZE;
/// Positions of the centers of the three finder markers (module coordinates).
pub const MARKERS: [[usize; 2]; 3] = [[3, 3], [N - 4, 3], [3, N - 4]];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModuleRole {
    Marker,
    Separator,
    Synchronization,
    Pilot,
    Data,
}

static ROLES: LazyLock<[ModuleRole; N * N]> = LazyLock::new(|| {
    let mut r = [ModuleRole::Data; N * N];
    // Finder markers + white separators (9×9 ring around each 7×7).
    for [cx, cy] in MARKERS {
        for dy in -4i32..=4 {
            for dx in -4i32..=4 {
                let x = cx as i32 + dx;
                let y = cy as i32 + dy;
                if x < 0 || y < 0 || x >= N as i32 || y >= N as i32 {
                    continue;
                }
                let in_marker = dx.abs() <= 3 && dy.abs() <= 3;
                r[y as usize * N + x as usize] = if in_marker {
                    ModuleRole::Marker
                } else {
                    ModuleRole::Separator
                };
            }
        }
    }
    // Timing lines (row 6 and column 6), outside the structural areas.
    for i in 8..N - 8 {
        if r[6 * N + i] == ModuleRole::Data {
            r[6 * N + i] = ModuleRole::Synchronization;
        }
        if r[i * N + 6] == ModuleRole::Data {
            r[i * N + 6] = ModuleRole::Synchronization;
        }
    }
    // Pilot ring: 8 modules at the bottom (y = N−1, x = 8..15) and 8 on the right
    // (x = N−1, y = 8..15), one per palette color.
    for i in 0..8 {
        r[(N - 1) * N + 8 + i] = ModuleRole::Pilot;
        r[(8 + i) * N + N - 1] = ModuleRole::Pilot;
    }
    r
});

pub fn role_of(x: usize, y: usize) -> ModuleRole {
    ROLES[y * N + x]
}

static DATA_MODULES: LazyLock<Vec<[usize; 2]>> = LazyLock::new(|| {
    let mut list = Vec::new();
    for y in 0..N {
        for x in 0..N {
            if ROLES[y * N + x] == ModuleRole::Data {
                list.push([x, y]);
            }
        }
    }
    list
});

/// Filling order of the data modules: row by row, top → bottom.
pub fn data_modules() -> &'static [[usize; 2]] {
    &DATA_MODULES
}

/// Number of data modules of the v0.1 grid (1423).
pub fn data_module_count() -> usize {
    DATA_MODULES.len()
}

/// Raw bits available per codec.
pub fn available_bits(codec: Codec) -> usize {
    data_module_count() * bits_per_module(codec)
}

/// Palette indices of the STRUCTURAL modules (markers, separators, timing,
/// pilots) — identical for all codecs; data at 0.
pub fn structural_grid(codec: Codec) -> Vec<u8> {
    let mut g = vec![0u8; N * N];
    let palette_size = palette_for(codec).len();
    for y in 0..N {
        for x in 0..N {
            let i = y * N + x;
            g[i] = match ROLES[i] {
                ModuleRole::Marker => {
                    let [cx, cy] = *MARKERS
                        .iter()
                        .find(|[mx, my]| mx.abs_diff(x) <= 3 && my.abs_diff(y) <= 3)
                        .expect("finder module outside any finder");
                    let ring = cx.abs_diff(x).max(cy.abs_diff(y));
                    // black ring, black 3×3 core, white gap
                    if ring == 3 || ring <= 1 {
                        0
                    } else {
                        1
                    }
                }
                ModuleRole::Separator => 1,
                ModuleRole::Synchronization => ((x + y) % 2) as u8,
                ModuleRole::Pilot => {
                    let rank = if x == N - 1 { y - 8 } else { x - 8 };
                    (rank % palette_size) as u8
                }
                ModuleRole::Data => 0,
            };
        }
    }
    g
}
