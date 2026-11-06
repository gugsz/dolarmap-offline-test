"""Gera os ícones PNG do DolarMap (pino de mapa sobre degradê verde) sem dependências.

Uso:  python tools/make_icons.py
"""
import math
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "icons")
TOP = (0x2B, 0xC2, 0x77)
BOTTOM = (0x0A, 0x6B, 0x43)
WHITE = (255, 255, 255)


def lerp(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(3))


PIN_CX, PIN_CY, PIN_R = 0.5, 0.405, 0.262
PIN_TX, PIN_TY = 0.5, 0.865


def _arc_dist(px, py, cx, cy, a, excl_from, excl_to):
    """Distância até um arco de círculo (ângulos em graus, y para baixo) que exclui (excl_from, excl_to)."""
    ang = math.degrees(math.atan2(py - cy, px - cx))
    inside_gap = excl_from < ang < excl_to if excl_from < excl_to else (ang > excl_from or ang < excl_to)
    if not inside_gap:
        return abs(math.hypot(px - cx, py - cy) - a)
    ends = []
    for deg in (excl_from, excl_to):
        r = math.radians(deg)
        ends.append(math.hypot(px - (cx + a * math.cos(r)), py - (cy + a * math.sin(r))))
    return min(ends)


def dollar_coverage(x, y):
    """1 se o ponto pertence ao símbolo "$" desenhado dentro da cabeça do pino."""
    cy = PIN_CY
    a = 0.062  # raio de cada metade do S
    sx = 1.22  # S um pouco mais largo
    w = 0.024  # meia espessura do traço
    px = PIN_CX + (x - PIN_CX) / sx
    # Metade de cima: de -25° (ponta direita) passando pelo topo e pela esquerda até embaixo (90°).
    d1 = _arc_dist(px, y, PIN_CX, cy - a, a, -25, 90)
    # Metade de baixo: do topo (-90°) pela direita até 155° (ponta esquerda).
    d2 = _arc_dist(px, y, PIN_CX, cy + a, a, 155, -90)
    # Barra vertical
    half = 2 * a + 0.045
    dy = max(abs(y - cy) - half, 0)
    d3 = math.hypot(x - PIN_CX, dy)
    return 1 if min(d1, d2) <= w or d3 <= w * 0.8 else 0


def pin_coverage(x, y):
    """1 se o ponto (0..1) está dentro do pino branco (exceto o "$"), senão 0."""
    cx, cy, r = PIN_CX, PIN_CY, PIN_R
    tx, ty = PIN_TX, PIN_TY
    dx, dy = x - cx, y - cy
    dist_c = math.hypot(dx, dy)
    if dist_c <= r:
        return 0 if dollar_coverage(x, y) else 1
    # Cone a partir da ponta, tangente ao círculo.
    d = math.hypot(cx - tx, cy - ty)
    ux, uy = (cx - tx) / d, (cy - ty) / d
    px, py = x - tx, y - ty
    proj = px * ux + py * uy
    if proj <= 0:
        return 0
    half = math.asin(r / d)
    ang = math.acos(max(-1.0, min(1.0, proj / max(math.hypot(px, py), 1e-9))))
    return 1 if ang <= half and proj <= (d * d - r * r) / d else 0


def render(size, ss=4):
    rows = []
    for j in range(size):
        row = bytearray([0])  # filtro PNG "None"
        for i in range(size):
            acc = 0
            for sj in range(ss):
                for si in range(ss):
                    x = (i + (si + 0.5) / ss) / size
                    y = (j + (sj + 0.5) / ss) / size
                    acc += pin_coverage(x, y)
            a = acc / (ss * ss)
            t = (i / size) * 0.35 + (j / size) * 0.65
            bg = lerp(TOP, BOTTOM, t)
            c = lerp(bg, WHITE, a)
            row += bytes(int(round(v)) for v in c)
        rows.append(bytes(row))
    return b"".join(rows)


def png(size, raw):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # RGB 8 bits, sem alfa (iOS prefere)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for s in (180, 192, 512):
        path = os.path.join(OUT, f"icon-{s}.png")
        with open(path, "wb") as f:
            f.write(png(s, render(s)))
        print("ok", path)
