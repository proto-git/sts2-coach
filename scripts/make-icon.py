#!/usr/bin/env python3
"""
Generate the app icons for STS2 Coach.

Outputs:
  assets/icon.png   — 512x512 master, used by Linux + as BrowserWindow.icon
  assets/icon.ico   — Windows multi-size ICO (16,32,48,64,128,256)
  assets/icon.icns  — macOS app bundle icon (built via iconutil/png2icns or via Pillow)

Design: dark indigo rounded-square card with a warm-amber overlay pill in the
corner (mirroring the in-app update pill) and a bold "C" mark. Matches the
overlay's visual language so it reads as the same product across surfaces.
"""

from __future__ import annotations
import os, struct, zlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ASSETS = Path(__file__).resolve().parent.parent / 'assets'
ASSETS.mkdir(exist_ok=True)

# Brand palette (matches overlay/style.css accent tokens).
INDIGO_DARK  = (24, 22, 45, 255)     # outer card
INDIGO_LIGHT = (62, 56, 120, 255)    # inner gradient
ACCENT_AMBER = (255, 184, 76, 255)   # update pill / focus
INK          = (245, 245, 250, 255)  # text
SHADOW       = (0, 0, 0, 110)


def linear_gradient(size: int, top: tuple, bottom: tuple) -> Image.Image:
    img = Image.new('RGBA', (size, size), top)
    px = img.load()
    for y in range(size):
        t = y / (size - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(size):
            px[x, y] = (r, g, b, 255)
    return img


def rounded_mask(size: int, radius: int) -> Image.Image:
    m = Image.new('L', (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return m


def load_bold_font(px: int) -> ImageFont.FreeTypeFont:
    candidates = [
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
    ]
    for c in candidates:
        if os.path.exists(c):
            return ImageFont.truetype(c, px)
    return ImageFont.load_default()


def make_master(size: int = 1024) -> Image.Image:
    """Render the icon at high resolution for clean downsampling."""
    pad = int(size * 0.06)
    inner = size - 2 * pad
    radius = int(inner * 0.22)

    # Outer card: gradient fill, rounded.
    grad = linear_gradient(inner, INDIGO_LIGHT, INDIGO_DARK)
    mask = rounded_mask(inner, radius)
    card = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    card.paste(grad, (0, 0), mask)

    # Subtle inner highlight stroke.
    stroke = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stroke)
    sd.rounded_rectangle((2, 2, inner - 3, inner - 3), radius=radius - 2,
                         outline=(255, 255, 255, 38), width=4)
    card = Image.alpha_composite(card, stroke)

    # Big "C" mark (Coach), slightly tracked-in.
    font = load_bold_font(int(inner * 0.62))
    txt = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    td = ImageDraw.Draw(txt)
    bbox = td.textbbox((0, 0), 'C', font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (inner - tw) // 2 - bbox[0]
    ty = (inner - th) // 2 - bbox[1] - int(inner * 0.02)

    # Drop shadow under glyph for a tactile feel.
    shadow_layer = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    sdraw = ImageDraw.Draw(shadow_layer)
    sdraw.text((tx + 4, ty + 8), 'C', font=font, fill=SHADOW)
    shadow_layer = shadow_layer.filter(ImageFilter.GaussianBlur(radius=6))
    card = Image.alpha_composite(card, shadow_layer)

    td.text((tx, ty), 'C', font=font, fill=INK)
    card = Image.alpha_composite(card, txt)

    # Amber "update" dot in the upper-right (visual echo of the in-app pill).
    dot_d = int(inner * 0.18)
    dot_pad = int(inner * 0.08)
    dot = Image.new('RGBA', (inner, inner), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dot)
    dd.ellipse(
        (inner - dot_pad - dot_d, dot_pad,
         inner - dot_pad,         dot_pad + dot_d),
        fill=ACCENT_AMBER,
        outline=(255, 255, 255, 60), width=3,
    )
    card = Image.alpha_composite(card, dot)

    # Compose into final canvas.
    out = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    out.paste(card, (pad, pad), mask)
    return out


def write_png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path, 'PNG')
    print(f'  wrote {path.relative_to(ASSETS.parent)} ({size}x{size})')


def write_ico(master: Image.Image, path: Path) -> None:
    """Multi-resolution ICO. Pillow handles this natively."""
    sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    master.save(path, format='ICO', sizes=sizes)
    print(f'  wrote {path.relative_to(ASSETS.parent)} (sizes: {", ".join(f"{w}x{h}" for w, h in sizes)})')


def write_icns(master: Image.Image, path: Path) -> None:
    """macOS .icns. Pillow >= 9 supports this directly."""
    # Pillow expects a single high-res image; it generates the required sub-sizes.
    master.resize((1024, 1024), Image.LANCZOS).save(path, format='ICNS')
    print(f'  wrote {path.relative_to(ASSETS.parent)}')


def write_tray_template(master: Image.Image) -> None:
    """Mac tray icon. 22x22 monochrome white-on-clear (template image).

    Mac tray uses the alpha channel + monochrome convention: any non-transparent
    pixel becomes the system-tinted color (white on dark menu bar, black on light).
    We render just the "C" silhouette without the card backdrop.
    """
    sz = 44  # 2x for retina
    img = Image.new('RGBA', (sz, sz), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    font = load_bold_font(int(sz * 0.85))
    bbox = d.textbbox((0, 0), 'C', font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (sz - tw) // 2 - bbox[0]
    ty = (sz - th) // 2 - bbox[1]
    d.text((tx, ty), 'C', font=font, fill=(255, 255, 255, 255))

    # Save 22x22 (mac standard) and the @2x variant.
    img.resize((22, 22), Image.LANCZOS).save(ASSETS / 'trayTemplate.png', 'PNG')
    img.save(ASSETS / 'trayTemplate@2x.png', 'PNG')
    print(f'  wrote assets/trayTemplate.png + @2x.png')


def main() -> None:
    print('Rendering icon master\u2026')
    master = make_master(1024)

    # PNG master (used by Linux + BrowserWindow.icon hint)
    write_png(master, ASSETS / 'icon.png', 512)

    # Windows
    write_ico(master, ASSETS / 'icon.ico')

    # macOS app bundle
    try:
        write_icns(master, ASSETS / 'icon.icns')
    except Exception as e:
        print(f'  WARN: could not write icon.icns ({e}). On Mac you can re-run with iconutil.')

    # Mac tray (monochrome template) — keep separate from app icon.
    write_tray_template(master)

    print('Done.')


if __name__ == '__main__':
    main()
