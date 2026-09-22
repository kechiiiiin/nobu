#!/usr/bin/env python3
"""NoBu のアイコン（PNG）を依存なしで描く。public/icons/ に出力。
紙色の地に、傾けた本が3冊並ぶ本棚。maskable でも欠けないよう中央 60% に収める。"""
import struct, zlib, os

BG = (0x2f, 0x4a, 0x3a)      # 深い緑
SHELF = (0xe9, 0xdf, 0xc9)
BOOKS = [(0xf6, 0xf1, 0xe7), (0xb5, 0x53, 0x2e), (0xd9, 0xb4, 0x6a)]

def png(w, h, px):
    raw = b"".join(b"\x00" + bytes(px[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")

def draw(n):
    px = bytearray(BG * (n * n))
    def rect(x0, y0, x1, y1, c, skew=0.0):
        for y in range(int(y0 * n), int(y1 * n)):
            off = skew * ((y1 * n) - y)
            for x in range(int(x0 * n + off), int(x1 * n + off)):
                if 0 <= x < n and 0 <= y < n:
                    i = (y * n + x) * 3
                    px[i:i + 3] = bytes(c)
    # 本（下端を棚にそろえる）
    rect(0.26, 0.28, 0.38, 0.70, BOOKS[0])
    rect(0.26, 0.34, 0.38, 0.37, BG)       # 背の帯
    rect(0.40, 0.24, 0.52, 0.70, BOOKS[1])
    rect(0.40, 0.60, 0.52, 0.63, BG)
    rect(0.56, 0.30, 0.67, 0.70, BOOKS[2], skew=0.28)
    # 棚板
    rect(0.20, 0.70, 0.80, 0.745, SHELF)
    return png(n, n, px)

out = os.path.join(os.path.dirname(__file__), "..", "public", "icons")
os.makedirs(out, exist_ok=True)
for name, n in [("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)]:
    with open(os.path.join(out, name), "wb") as f:
        f.write(draw(n))
print("icons written")
