"""Generate the app icons (PNG + SVG) with the stdlib only.

    python3 tools/make_icons.py

A placeholder: one rounded tile on a light background. A new app changes
BG and TILE (or replaces tiles() with its own shape) and runs this again.
"""

import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "icons"

BG = (247, 245, 240)
TILE = (52, 98, 140)


def tiles(inset):
    """Tile rectangles (x, y, size, color) in unit coordinates, and the corner radius."""
    size = 1 - 2 * inset
    return [(inset, inset, size, TILE)], size * 0.22


def inside_rounded(px, py, x, y, s, rad):
    if not (x <= px <= x + s and y <= py <= y + s):
        return False
    cx = min(max(px, x + rad), x + s - rad)
    cy = min(max(py, y + rad), y + s - rad)
    return (px - cx) ** 2 + (py - cy) ** 2 <= rad * rad


def render_png(path, size, inset):
    rects, rad = tiles(inset)
    ss = 3  # supersampling per axis
    rows = []
    for yi in range(size):
        row = bytearray([0])  # filter: none
        for xi in range(size):
            acc = [0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    px = (xi + (sx + 0.5) / ss) / size
                    py = (yi + (sy + 0.5) / ss) / size
                    color = BG
                    for x, y, s, col in rects:
                        if inside_rounded(px, py, x, y, s, rad):
                            color = col
                            break
                    acc[0] += color[0]
                    acc[1] += color[1]
                    acc[2] += color[2]
            n = ss * ss
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))
    raw = b"".join(rows)

    def chunk(kind, data):
        c = struct.pack(">I", len(data)) + kind + data
        return c + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)


def render_svg(path, inset):
    rects, rad = tiles(inset)
    hexc = lambda c: "#%02x%02x%02x" % c  # noqa: E731
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
        f'<rect width="100" height="100" rx="22" fill="{hexc(BG)}"/>',
    ]
    for x, y, s, col in rects:
        parts.append(
            f'<rect x="{x * 100:.2f}" y="{y * 100:.2f}" width="{s * 100:.2f}" height="{s * 100:.2f}" '
            f'rx="{rad * 100:.2f}" fill="{hexc(col)}"/>'
        )
    parts.append("</svg>\n")
    path.write_text("".join(parts))


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    render_svg(OUT / "icon.svg", 0.14)
    render_png(OUT / "icon-192.png", 192, 0.14)
    render_png(OUT / "icon-512.png", 512, 0.14)
    render_png(OUT / "apple-touch-icon.png", 180, 0.14)
    # Maskable icons get cropped to a circle; keep the grid in the safe zone.
    render_png(OUT / "icon-maskable-512.png", 512, 0.22)
    print(f"wrote icons to {OUT}")


if __name__ == "__main__":
    main()
