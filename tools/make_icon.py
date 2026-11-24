#!/usr/bin/env python3
"""
Generate Shonchoy's logo assets using only the Python standard library.

Outputs (in assets/ by default):
  shonchoy-64.png    used inside the app header and as the window icon
  shonchoy-256.png   high-resolution copy
  shonchoy.ico       multi-size Windows icon (16, 32, 48, 256)

The same design lives in assets/shonchoy.svg as a vector source.
"""
import struct
import sys
import zlib
from pathlib import Path

TEAL = (15, 118, 110)
DEEP = (12, 74, 70)
WHITE = (255, 255, 255)


def render(size: int) -> bytearray:
    """Rasterise the logo as RGBA bytes."""
    w = h = size
    radius = size * 0.22
    buf = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            px, py = x + 0.5, y + 0.5
            cx = min(max(px, radius), w - radius)
            cy = min(max(py, radius), h - radius)
            if (px - cx) ** 2 + (py - cy) ** 2 > radius * radius:
                continue  # transparent rounded corner
            u, v = px / w, py / h
            colour = TEAL
            if 0.20 <= u <= 0.80 and 0.22 <= v <= 0.40:          # lid
                colour = WHITE
            if 0.26 <= u <= 0.74 and 0.44 <= v <= 0.80:          # body
                colour = WHITE
            if (0.46 <= u <= 0.54 and 0.48 <= v < 0.78
                    and int((v - 0.48) / 0.045) % 2 == 0):       # zipper teeth
                colour = DEEP
            i = (y * w + x) * 4
            buf[i:i + 4] = bytes((*colour, 255))
    return buf


def encode_png(size: int, pixels: bytearray) -> bytes:
    raw = b"".join(b"\x00" + bytes(pixels[y * size * 4:(y + 1) * size * 4]) for y in range(size))

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header)
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def encode_ico(images) -> bytes:
    """images: list of (size, png_bytes). PNG-compressed ICO entries (Windows Vista+)."""
    out_header = struct.pack("<HHH", 0, 1, len(images))
    directory = b""
    payload = b""
    offset = 6 + 16 * len(images)
    for size, png_bytes in images:
        dim = 0 if size >= 256 else size
        directory += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(png_bytes), offset)
        payload += png_bytes
        offset += len(png_bytes)
    return out_header + directory + payload


def main(argv):
    out_dir = Path(argv[0]) if argv else Path(__file__).resolve().parent.parent / "assets"
    out_dir.mkdir(parents=True, exist_ok=True)

    rendered = {}
    for size in (16, 32, 48, 64, 256):
        rendered[size] = encode_png(size, render(size))

    (out_dir / "shonchoy-64.png").write_bytes(rendered[64])
    (out_dir / "shonchoy-256.png").write_bytes(rendered[256])
    (out_dir / "shonchoy.ico").write_bytes(
        encode_ico([(s, rendered[s]) for s in (16, 32, 48, 256)]))
    print(f"Wrote logo assets to {out_dir}")


if __name__ == "__main__":
    main(sys.argv[1:])
