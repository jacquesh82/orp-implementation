//! Screen rendering and digital image — PURE functions: RGBA buffers that are
//! directly testable and reusable by the camera simulation.

use crate::grid::GRID_SIZE;
use crate::palettes::RgbColor;

/// RGBA image, 4 bytes per pixel, row by row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageRGBA {
    pub width: usize,
    pub height: usize,
    pub data: Vec<u8>,
}

impl ImageRGBA {
    /// Opaque white image.
    pub fn white(width: usize, height: usize) -> Self {
        Self {
            width,
            height,
            data: vec![255; width * height * 4],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RenderOptions {
    /// Pixels per module (default 8).
    pub module_size: usize,
    /// Modules of white around the grid (default 2).
    pub quiet_zone: usize,
}

impl Default for RenderOptions {
    fn default() -> Self {
        Self {
            module_size: 8,
            quiet_zone: 2,
        }
    }
}

/// Side in pixels of a rendered grid.
pub fn rendered_side(options: &RenderOptions) -> usize {
    (GRID_SIZE + 2 * options.quiet_zone) * options.module_size
}

/// Renders a grid into `dest` (width `dest_width`), corner at (ox, oy).
fn render_into(
    grid: &[u8],
    palette: &[RgbColor],
    options: &RenderOptions,
    dest: &mut [u8],
    dest_width: usize,
    ox: usize,
    oy: usize,
) {
    let tm = options.module_size;
    let edge = options.quiet_zone * tm;
    let side = rendered_side(options);
    for py in 0..side {
        let line = &mut dest
            [((oy + py) * dest_width + ox) * 4..((oy + py) * dest_width + ox + side) * 4];
        let in_y = py >= edge && py < edge + GRID_SIZE * tm;
        for px in 0..side {
            let color = if in_y && px >= edge && px < edge + GRID_SIZE * tm {
                let my = (py - edge) / tm;
                let mx = (px - edge) / tm;
                palette[grid[my * GRID_SIZE + mx] as usize]
            } else {
                [255, 255, 255]
            };
            let o = px * 4;
            line[o] = color[0];
            line[o + 1] = color[1];
            line[o + 2] = color[2];
            line[o + 3] = 255;
        }
    }
}

/// Grid → RGBA image (what the screen must show).
pub fn render(grid: &[u8], palette: &[RgbColor], options: &RenderOptions) -> ImageRGBA {
    let side = rendered_side(options);
    let mut image = ImageRGBA::white(side, side);
    render_into(grid, palette, options, &mut image.data, side, 0, 0);
    image
}

/// Mosaic: several grids side by side, `columns` per row, each with its
/// quiet zone. A cell without a grid stays white.
pub fn render_mosaic<G: AsRef<[u8]>>(
    grids: &[G],
    palette: &[RgbColor],
    columns: usize,
    options: &RenderOptions,
) -> ImageRGBA {
    if grids.is_empty() {
        return ImageRGBA {
            width: 0,
            height: 0,
            data: Vec::new(),
        };
    }
    let side = rendered_side(options);
    let lines = grids.len().div_ceil(columns);
    let width = side * columns;
    let mut image = ImageRGBA::white(width, side * lines);
    for (i, g) in grids.iter().enumerate() {
        render_into(
            g.as_ref(),
            palette,
            options,
            &mut image.data,
            width,
            (i % columns) * side,
            (i / columns) * side,
        );
    }
    image
}
