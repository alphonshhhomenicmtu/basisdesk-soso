#!/usr/bin/env python3
"""
Render broadcast-grade 1920x1080 30fps H.264 High@4.1 demo video for BasisDesk.
Features:
- Sub-pixel smooth camera pans & zooms across all 4 Retina screenshots (zero jitter)
- Pixel-locked glowing highlight rings on key quantitative widgets
- Top HUD with 5-chapter labeled progress bar & tabular timecode
- Dedicated bottom subtitle tray (burned-in synced subtitles, zero overlap with UI or progress bar)
- Broadcast Title Slate & Engineering Proof Closing Slate
- Muxed with 2-pass -14 LUFS mastered AAC 192k 48kHz stereo audio + faststart
"""
from __future__ import annotations

import functools
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FFMPEG = "/Users/mac/GENAI/agent-earn/dorahacks/even-realities/demo-video/bin/ffmpeg"
FFPROBE = "/Users/mac/GENAI/agent-earn/dorahacks/even-realities/demo-video/bin/ffprobe"

BASE_DIR = Path("/Users/mac/GENAI/agent-earn/akindo/sosovalue-desk/demo-video")
AUDIO_DIR = BASE_DIR / "audio"
SHOT_DIR = Path("/Users/mac/GENAI/agent-earn/akindo/sosovalue-desk/docs/screenshots")
KEYFRAME_DIR = BASE_DIR / "keyframes"
KEYFRAME_DIR.mkdir(parents=True, exist_ok=True)

OUT_MP4 = BASE_DIR / "basisdesk-demo-1080p.mp4"
OUT_SRT = BASE_DIR / "basisdesk-demo-1080p.srt"

W, H = 1920, 1080
FPS = 30

# Strict zero-overlap layout zones
HUD_H = 78
VP_X, VP_Y = 40, 86
VP_W, VP_H = 1840, 858
VP_AR = VP_W / VP_H  # 2.144522
SUB_Y0, SUB_Y1 = 954, 1068  # 114px tall subtitle zone, centered at y=1011

# Fonts (native macOS TTCs verified earlier)
FONT_HELV = "/System/Library/Fonts/HelveticaNeue.ttc"
FONT_AVENIR = "/System/Library/Fonts/Avenir Next.ttc"
FONT_MENLO = "/System/Library/Fonts/Menlo.ttc"


@functools.lru_cache(maxsize=64)
def font_sans(size: int, weight: str = "regular") -> ImageFont.FreeTypeFont:
    idx_map = {"regular": 0, "bold": 1, "medium": 10, "light": 7}
    return ImageFont.truetype(FONT_HELV, size, index=idx_map.get(weight, 0))


@functools.lru_cache(maxsize=64)
def font_display(size: int, weight: str = "bold") -> ImageFont.FreeTypeFont:
    idx_map = {"bold": 0, "demibold": 2, "medium": 5, "regular": 7, "heavy": 8}
    return ImageFont.truetype(FONT_AVENIR, size, index=idx_map.get(weight, 0))


@functools.lru_cache(maxsize=64)
def font_mono(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_MENLO, size, index=1 if bold else 0)


# Color palette (BasisDesk dark institutional theme)
BG_DARK = (6, 9, 15)
CYAN = (56, 189, 248)
EMERALD = (52, 211, 153)
AMBER = (251, 191, 36)
ROSE = (244, 63, 94)
PURPLE = (167, 139, 250)
TEXT_BRIGHT = (248, 250, 252)
TEXT_MUTED = (148, 163, 184)
TEXT_DIM = (100, 116, 139)


def ease_in_out_cubic(u: float) -> float:
    u = max(0.0, min(1.0, u))
    if u < 0.5:
        return 4.0 * u * u * u
    return 1.0 - ((-2.0 * u + 2.0) ** 3) / 2.0


def ease_out_cubic(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return 1.0 - (1.0 - u) ** 3


def smoothstep(u: float) -> float:
    u = max(0.0, min(1.0, u))
    return u * u * (3.0 - 2.0 * u)


def fmt_time(sec: float) -> str:
    s = max(0, int(round(sec)))
    return f"{s // 60:02d}:{s % 60:02d}"


def fmt_srt_time(sec: float) -> str:
    ms_total = max(0, int(round(sec * 1000)))
    h = ms_total // 3600000
    m = (ms_total % 3600000) // 60000
    s = (ms_total % 60000) // 1000
    ms = ms_total % 1000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def build_background_canvas() -> np.ndarray:
    """Deep BasisDesk radial obsidian-navy gradient + subtle architectural grid + viewport bezel."""
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    dx = (xx - W * 0.5) / (W * 0.65)
    dy = (yy - H * 0.45) / (H * 0.65)
    r2 = np.clip(dx * dx + dy * dy, 0.0, 1.5)
    falloff = np.exp(-1.15 * r2)

    base = np.zeros((H, W, 3), dtype=np.float32)
    base[:, :, 0] = 5.0 + 9.0 * falloff
    base[:, :, 1] = 8.0 + 14.0 * falloff
    base[:, :, 2] = 14.0 + 24.0 * falloff

    # Subtle 48px architectural grid
    grid_mask = ((np.arange(W)[None, :] % 48 == 0) | (np.arange(H)[:, None] % 48 == 0))
    base[grid_mask] += np.array([3.0, 6.0, 10.0], dtype=np.float32)

    img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8)).convert("RGBA")
    draw = ImageDraw.Draw(img)

    # Top HUD subtle frosted bar background
    draw.rectangle([0, 0, W, HUD_H], fill=(7, 11, 18, 238))
    draw.line([(0, HUD_H), (W, HUD_H)], fill=(30, 41, 59, 220), width=1)

    # Soft outer glow behind viewport
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.rounded_rectangle(
        [VP_X - 3, VP_Y - 3, VP_X + VP_W + 3, VP_Y + VP_H + 3],
        radius=15,
        outline=(56, 189, 248, 58),
        width=4,
    )
    glow = glow.filter(ImageFilter.GaussianBlur(radius=8))
    img = Image.alpha_composite(img, glow)

    # Crisp 1px bezel around viewport
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle(
        [VP_X - 1, VP_Y - 1, VP_X + VP_W + 1, VP_Y + VP_H + 1],
        radius=13,
        outline=(51, 65, 85, 220),
        width=2,
    )
    return np.array(img.convert("RGB"), dtype=np.uint8)


def build_viewport_mask() -> np.ndarray:
    """Rounded-corner mask (radius=12) for the 1840x858 viewport (float32 0..1)."""
    mask = Image.new("L", (VP_W, VP_H), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, VP_W - 1, VP_H - 1], radius=12, fill=255)
    return (np.array(mask, dtype=np.float32) / 255.0)[:, :, None]


def render_intro_slate(overview_rgb: np.ndarray) -> np.ndarray:
    """Broadcast-grade BasisDesk Title Slate inside 1840x858 viewport."""
    # Dimmed blurred backdrop of the real Overview Desk
    bg_im = Image.fromarray(overview_rgb[:1343, :, :]).resize((VP_W, VP_H), Image.Resampling.LANCZOS)
    bg_im = bg_im.filter(ImageFilter.GaussianBlur(radius=14))
    arr = (np.array(bg_im, dtype=np.float32) * 0.20).astype(np.uint8)

    # Radial dark vignette + subtle cyan top glow
    yy, xx = np.mgrid[0:VP_H, 0:VP_W].astype(np.float32)
    gx = (xx - VP_W * 0.5) / (VP_W * 0.42)
    gy = (yy - VP_H * 0.22) / (VP_H * 0.48)
    cyan_glow = np.exp(-(gx * gx + gy * gy) * 1.4)
    arr_f = arr.astype(np.float32)
    arr_f[:, :, 0] += 8.0 + 10.0 * cyan_glow
    arr_f[:, :, 1] += 12.0 + 28.0 * cyan_glow
    arr_f[:, :, 2] += 20.0 + 42.0 * cyan_glow

    im = Image.fromarray(np.clip(arr_f, 0, 255).astype(np.uint8)).convert("RGBA")
    draw = ImageDraw.Draw(im)

    # Subtle accent rule
    cx = VP_W // 2

    # Top pill badge
    badge_txt = "AKINDO WAVEHACK · WAVE 3 · SOSOVALUE × VALUECHAIN × SODEX"
    fb = font_mono(16, bold=True)
    bb = draw.textbbox((0, 0), badge_txt, font=fb)
    bw = bb[2] - bb[0] + 44
    bh = 38
    draw.rounded_rectangle(
        [cx - bw // 2, 118, cx + bw // 2, 118 + bh],
        radius=19,
        fill=(12, 34, 52, 220),
        outline=(56, 189, 248, 170),
        width=1,
    )
    draw.text((cx, 118 + bh // 2), badge_txt, font=fb, fill=(125, 211, 252, 255), anchor="mm")

    # Hero logo + title
    # Mini waveform logo box beside title
    f_hero = font_display(92, "bold")
    hero_txt = "BasisDesk"
    hb = draw.textbbox((0, 0), hero_txt, font=f_hero)
    hw = hb[2] - hb[0]
    logo_s = 76
    gap = 26
    total_w = logo_s + gap + hw
    lx0 = cx - total_w // 2
    ly0 = 218

    draw.rounded_rectangle(
        [lx0, ly0, lx0 + logo_s, ly0 + logo_s],
        radius=16,
        fill=(10, 28, 42, 240),
        outline=(56, 189, 248, 220),
        width=2,
    )
    # Pulse waveform inside logo
    pts = [
        (lx0 + 13, ly0 + 44),
        (lx0 + 26, ly0 + 44),
        (lx0 + 34, ly0 + 20),
        (lx0 + 44, ly0 + 58),
        (lx0 + 53, ly0 + 34),
        (lx0 + 63, ly0 + 34),
    ]
    draw.line(pts, fill=(56, 189, 248, 255), width=4, joint="curve")
    draw.text((lx0 + logo_s + gap, ly0 + logo_s // 2 + 2), hero_txt, font=f_hero, fill=TEXT_BRIGHT, anchor="lm")

    # Subtitle
    f_sub = font_sans(32, "medium")
    draw.text(
        (cx, 356),
        "Autonomous One-Person On-Chain Quant & Risk Terminal",
        font=f_sub,
        fill=(186, 230, 253, 255),
        anchor="mm",
    )

    # Concise positioning line
    f_tag = font_sans(22, "regular")
    draw.text(
        (cx, 412),
        "Live Mainnet Perp-Spot Carry  ·  Deterministic Monte Carlo Stress Lab  ·  SSI Basket Rebalancing",
        font=f_tag,
        fill=TEXT_MUTED,
        anchor="mm",
    )

    # Divider line
    draw.line([(cx - 420, 472), (cx + 420, 472)], fill=(51, 65, 85, 180), width=1)

    # 4 Live Architecture Stat Cards
    cards = [
        ("SODEX MAINNET WS", "500ms L2 Depth", "107 Perps · 48 Spot & SSI", EMERALD),
        ("VALUECHAIN L1 RPC", "Chain 286623", "2s Finality · Live SOSO Gas", PURPLE),
        ("MONTE CARLO ENGINE", "1,000 Paths", "Seeded Jumps · VaR / CVaR", ROSE),
        ("SSI INDEX PROTOCOL", "AssetRebalancer", "Buffer-Band Drift · 10^8", CYAN),
    ]
    cw, ch_box, cgap = 388, 174, 24
    start_x = cx - (4 * cw + 3 * cgap) // 2
    cy0 = 528

    f_k = font_mono(14, bold=True)
    f_v = font_display(32, "bold")
    f_d = font_sans(18, "regular")

    for i, (k, v, desc, col) in enumerate(cards):
        x0 = start_x + i * (cw + cgap)
        draw.rounded_rectangle(
            [x0, cy0, x0 + cw, cy0 + ch_box],
            radius=14,
            fill=(11, 17, 29, 235),
            outline=(30, 41, 59, 255),
            width=2,
        )
        # Colored top accent strip
        draw.rounded_rectangle([x0 + 20, cy0 + 18, x0 + 30, cy0 + 28], radius=5, fill=col)
        draw.text((x0 + 42, cy0 + 23), k, font=f_k, fill=col, anchor="lm")
        draw.text((x0 + 22, cy0 + 82), v, font=f_v, fill=TEXT_BRIGHT, anchor="lm")
        draw.text((x0 + 22, cy0 + 132), desc, font=f_d, fill=TEXT_MUTED, anchor="lm")

    # Bottom disclaimer note
    f_foot = font_mono(14, bold=False)
    draw.text(
        (cx, 782),
        "ZERO CUSTODY  ·  PAPER EXECUTION SIMULATION ONLY  ·  HONEST LIVE / SNAPSHOT TELEMETRY",
        font=f_foot,
        fill=TEXT_DIM,
        anchor="mm",
    )
    return np.array(im.convert("RGB"), dtype=np.uint8)


def render_outro_slate(overview_rgb: np.ndarray, highlight_final: bool = False) -> np.ndarray:
    """Broadcast-grade Engineering Proof & Closing Slate inside 1840x858 viewport."""
    bg_im = Image.fromarray(overview_rgb[1800:, :, :]).resize((VP_W, VP_H), Image.Resampling.LANCZOS)
    bg_im = bg_im.filter(ImageFilter.GaussianBlur(radius=16))
    arr = (np.array(bg_im, dtype=np.float32) * 0.16).astype(np.uint8)

    yy, xx = np.mgrid[0:VP_H, 0:VP_W].astype(np.float32)
    gx = (xx - VP_W * 0.5) / (VP_W * 0.45)
    gy = (yy - VP_H * 0.5) / (VP_H * 0.55)
    glow = np.exp(-(gx * gx + gy * gy) * 1.2)
    arr_f = arr.astype(np.float32)
    arr_f[:, :, 0] += 7.0 + 8.0 * glow
    arr_f[:, :, 1] += 11.0 + 24.0 * glow
    arr_f[:, :, 2] += 18.0 + 36.0 * glow

    im = Image.fromarray(np.clip(arr_f, 0, 255).astype(np.uint8)).convert("RGBA")
    draw = ImageDraw.Draw(im)
    cx = VP_W // 2

    # Top status badge
    f_badge = font_mono(15, bold=True)
    btxt = "PRODUCTION-VERIFIED BUILD  ·  AKINDO WAVE 3 SUBMISSION"
    bb = draw.textbbox((0, 0), btxt, font=f_badge)
    bw = bb[2] - bb[0] + 42
    draw.rounded_rectangle(
        [cx - bw // 2, 74, cx + bw // 2, 110],
        radius=18,
        fill=(10, 40, 34, 230),
        outline=(52, 211, 153, 180),
        width=1,
    )
    draw.text((cx, 92), btxt, font=f_badge, fill=(110, 231, 183, 255), anchor="mm")

    # Title
    f_h = font_display(64, "bold")
    draw.text((cx, 174), "BasisDesk v1.0", font=f_h, fill=TEXT_BRIGHT, anchor="mm")
    f_sub = font_sans(24, "regular")
    draw.text(
        (cx, 226),
        "Verified Live Mainnet Integrations · Deterministic TypeScript Quant Core · Static Zero-Backend Deploy",
        font=f_sub,
        fill=TEXT_MUTED,
        anchor="mm",
    )

    # 2x2 Engineering Proof Grid
    proofs = [
        ("16 / 16 Vitest Unit Tests Passing", "Carry APY, L2 slippage, Mulberry32 Monte Carlo VaR/CVaR & SSI drift math verified", EMERALD, "VERIFIED"),
        ("GitHub Pages + Hourly Snapshot CI", "Static Vite bundle (tsc --noEmit clean) + automated hourly snapshot workflow", CYAN, "DEPLOYED"),
        ("Live Mainnet WS & EVM Telemetry", "SoDEX 500ms WS (107 perps / 48 spot) + ValueChain Chain 286623 (2s finality)", PURPLE, "LIVE MAINNET"),
        ("5-Rule Risk Gate · Zero Custody", "2-step guarded paper blotter + memory-only BYOK SoSoValue Open API v1 drawer", AMBER, "GUARDED"),
    ]
    pw, ph, gx_p, gy_p = 786, 146, 32, 26
    x_left = cx - pw - gx_p // 2
    y_top = 282

    f_pt = font_display(26, "bold")
    f_pd = font_sans(17, "regular")
    f_pp = font_mono(13, bold=True)

    for idx, (title, desc, col, pill) in enumerate(proofs):
        col_i = idx % 2
        row_i = idx // 2
        x0 = x_left + col_i * (pw + gx_p)
        y0 = y_top + row_i * (ph + gy_p)
        draw.rounded_rectangle(
            [x0, y0, x0 + pw, y0 + ph],
            radius=14,
            fill=(11, 17, 29, 238),
            outline=(col[0], col[1], col[2], 140) if highlight_final else (30, 41, 59, 255),
            width=2,
        )
        # Left color bar
        draw.rounded_rectangle([x0 + 16, y0 + 22, x0 + 22, y0 + ph - 22], radius=3, fill=col)
        # Right badge pill
        pb = draw.textbbox((0, 0), pill, font=f_pp)
        pill_w = pb[2] - pb[0] + 22
        draw.rounded_rectangle(
            [x0 + pw - pill_w - 22, y0 + 22, x0 + pw - 22, y0 + 48],
            radius=13,
            fill=(col[0] // 5, col[1] // 5, col[2] // 5, 230),
            outline=(col[0], col[1], col[2], 180),
            width=1,
        )
        draw.text((x0 + pw - pill_w // 2 - 22, y0 + 35), pill, font=f_pp, fill=col, anchor="mm")

        draw.text((x0 + 42, y0 + 44), title, font=f_pt, fill=TEXT_BRIGHT, anchor="lm")
        draw.text((x0 + 42, y0 + 96), desc, font=f_pd, fill=TEXT_MUTED, anchor="lm")

    # Final closing banner at bottom of viewport
    by0 = 648
    border_col = (56, 189, 248, 220) if highlight_final else (51, 65, 85, 200)
    fill_col = (12, 30, 48, 240) if highlight_final else (10, 16, 28, 230)
    draw.rounded_rectangle(
        [x_left, by0, x_left + 2 * pw + gx_p, by0 + 132],
        radius=16,
        fill=fill_col,
        outline=border_col,
        width=2,
    )
    f_close = font_display(32, "bold")
    draw.text(
        (cx, by0 + 46),
        "Zero Custody.  Honest Telemetry.  Institutional Risk Discipline.",
        font=f_close,
        fill=(186, 230, 253, 255) if highlight_final else TEXT_BRIGHT,
        anchor="mm",
    )
    f_close2 = font_mono(17, bold=False)
    draw.text(
        (cx, by0 + 94),
        "SoSoValue Open API v1  ×  SoDEX Mainnet CLOB  ×  ValueChain L1 (Chain 286623)  ×  SSI Protocol",
        font=f_close2,
        fill=TEXT_MUTED,
        anchor="mm",
    )
    return np.array(im.convert("RGB"), dtype=np.uint8)


def prerender_subtitle_card(lines: list[str]) -> np.ndarray:
    """
    Render a broadcast-clean subtitle card inside (1920, 120) RGBA strip placed at y = 954..1074.
    Never overlaps the viewport (y<=944) or bottom frame edge (y=1080).
    """
    h_strip = 120
    im = Image.new("RGBA", (W, h_strip), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    f = font_sans(27, "medium")

    widths = []
    heights = []
    for ln in lines:
        bb = draw.textbbox((0, 0), ln, font=f)
        widths.append(bb[2] - bb[0])
        heights.append(bb[3] - bb[1])

    max_w = max(widths) if widths else 0
    line_gap = 10
    total_h = sum(heights) + line_gap * max(0, len(lines) - 1)
    pad_x = 34
    pad_y = 14
    box_w = min(W - 120, max_w + 2 * pad_x)
    box_h = min(h_strip - 8, total_h + 2 * pad_y)

    x0 = (W - box_w) // 2
    y0 = (h_strip - box_h) // 2
    draw.rounded_rectangle(
        [x0, y0, x0 + box_w, y0 + box_h],
        radius=12,
        fill=(9, 14, 25, 240),
        outline=(51, 65, 85, 200),
        width=1,
    )

    # Subtle cyan left accent bar inside subtitle pill
    draw.rounded_rectangle([x0 + 8, y0 + 12, x0 + 12, y0 + box_h - 12], radius=2, fill=(56, 189, 248, 210))

    cur_y = y0 + (box_h - total_h) // 2
    for ln, lh in zip(lines, heights):
        # Soft dark drop shadow for maximum crispness
        draw.text((W // 2 + 1, cur_y + lh // 2 + 1), ln, font=f, fill=(0, 0, 0, 180), anchor="mm")
        draw.text((W // 2, cur_y + lh // 2), ln, font=f, fill=TEXT_BRIGHT, anchor="mm")
        cur_y += lh + line_gap

    return np.array(im, dtype=np.uint8)


_HUD_BASE_CACHE: dict[tuple[int, str], np.ndarray] = {}


def render_hud_strip(chapters: list[dict], active_ch: int, t: float, total_dur: float) -> np.ndarray:
    """
    Render the Top HUD + 5-Chapter Progress Bar (1920 x 78 RGB).
    Static chrome + timecode cached per (active_ch, MM:SS), with smooth 30fps progress fill drawn via NumPy.
    """
    tc_str = f"{fmt_time(t)} / {fmt_time(total_dur)}"
    cache_key = (active_ch, tc_str)
    bar_x0 = 40
    bar_w_total = 1840
    gap = 10
    seg_w = (bar_w_total - 4 * gap) // 5  # 360px each
    seg_y0, seg_y1 = 41, 70
    track_y0, track_y1 = seg_y1 - 5, seg_y1 - 1

    base = _HUD_BASE_CACHE.get(cache_key)
    if base is None:
        im = Image.new("RGBA", (W, HUD_H), (7, 11, 18, 255))
        draw = ImageDraw.Draw(im)
        ch_obj = next(c for c in chapters if c["id"] == active_ch)

        draw.ellipse([42, 16, 52, 26], fill=EMERALD)
        draw.text((62, 21), "BasisDesk", font=font_display(20, "bold"), fill=TEXT_BRIGHT, anchor="lm")

        draw.rounded_rectangle([170, 11, 290, 31], radius=6, fill=(12, 34, 52, 255), outline=(56, 189, 248, 160), width=1)
        draw.text((230, 21), "QUANT TERMINAL", font=font_mono(11, bold=True), fill=(125, 211, 252, 255), anchor="mm")

        draw.line([(308, 11), (308, 31)], fill=(51, 65, 85, 220), width=1)
        draw.text((324, 21), f"Chapter {active_ch}/5  ·  {ch_obj['title']}", font=font_sans(16, "medium"), fill=(226, 232, 240, 255), anchor="lm")

        draw.text((W - 42, 21), tc_str, font=font_mono(15, bold=True), fill=TEXT_BRIGHT, anchor="rm")
        draw.text((W - 180, 21), "AKINDO Wave 3  ·  SoSoValue × SoDEX × ValueChain", font=font_mono(13, bold=False), fill=TEXT_MUTED, anchor="rm")

        f_seg = font_sans(13, "medium")
        f_seg_b = font_sans(13, "bold")
        for i, ch in enumerate(chapters):
            sx0 = bar_x0 + i * (seg_w + gap)
            sx1 = sx0 + seg_w
            cid = ch["id"]
            state = "done" if cid < active_ch else ("active" if cid == active_ch else "todo")

            bg_c = (14, 32, 50, 255) if state == "active" else (15, 23, 38, 255)
            out_c = (56, 189, 248, 210) if state == "active" else ((30, 58, 70, 220) if state == "done" else (30, 41, 59, 200))
            draw.rounded_rectangle([sx0, seg_y0, sx1, seg_y1], radius=6, fill=bg_c, outline=out_c, width=1)
            draw.rectangle([sx0 + 3, track_y0, sx1 - 3, track_y1], fill=(22, 33, 52, 255))
            if state == "done":
                draw.rectangle([sx0 + 3, track_y0, sx1 - 3, track_y1], fill=(52, 211, 153, 215))

            txt_c = TEXT_BRIGHT if state == "active" else ((167, 243, 208, 225) if state == "done" else TEXT_DIM)
            draw.text(
                ((sx0 + sx1) // 2, seg_y0 + 12),
                ch["short"],
                font=f_seg_b if state == "active" else f_seg,
                fill=txt_c,
                anchor="mm",
            )

        draw.line([(0, HUD_H - 1), (W, HUD_H - 1)], fill=(30, 41, 59, 240), width=1)
        base = np.array(im.convert("RGB"), dtype=np.uint8)
        _HUD_BASE_CACHE[cache_key] = base

    out = base.copy()
    # Paint smooth live 30fps progress fill inside active chapter segment
    ch_obj = next(c for c in chapters if c["id"] == active_ch)
    frac = max(0.0, min(1.0, (t - ch_obj["start"]) / max(0.001, ch_obj["end"] - ch_obj["start"])))
    if frac > 0.0:
        sx0 = bar_x0 + (active_ch - 1) * (seg_w + gap)
        fill_x1 = sx0 + 3 + int(round((seg_w - 6) * frac))
        out[track_y0 : track_y1 + 1, sx0 + 3 : fill_x1 + 1] = np.array([56, 189, 248], dtype=np.uint8)
    return out


def crop_screenshot_subpixel(src_rgb: np.ndarray, cx: float, cy: float, view_w: float) -> tuple[np.ndarray, tuple[float, float, float, float]]:
    """
    Extract (VP_W x VP_H) view from src_rgb using sub-pixel smooth affine warping.
    Returns (frame_rgb, (x0, y0, sx, sy)) so overlays can be mapped identically.
    """
    sh, sw, _ = src_rgb.shape
    vw = min(float(sw), max(600.0, float(view_w)))
    vh = vw / VP_AR
    if vh > sh:
        vh = float(sh)
        vw = vh * VP_AR

    x0 = max(0.0, min(sw - vw, cx - vw * 0.5))
    y0 = max(0.0, min(sh - vh, cy - vh * 0.5))

    sx = VP_W / vw
    sy = VP_H / vh
    M = np.array([[sx, 0.0, -x0 * sx], [0.0, sy, -y0 * sy]], dtype=np.float32)

    # INTER_AREA is crispest for downscaling Retina text; INTER_CUBIC for near-1:1 / slight zoom
    interp = cv2.INTER_AREA if sx < 0.90 else cv2.INTER_CUBIC
    out = cv2.warpAffine(src_rgb, M, (VP_W, VP_H), flags=interp, borderMode=cv2.BORDER_REPLICATE)
    return out, (x0, y0, sx, sy)


def draw_highlight_boxes(
    vp_rgb: np.ndarray,
    transform: tuple[float, float, float, float],
    boxes: list[dict],
    alpha_scale: float,
) -> np.ndarray:
    """
    Draw crisp anti-aliased glowing focus rectangles + optional mini tag pills
    mapped from source-image pixel coords onto the current viewport frame.
    """
    if not boxes or alpha_scale <= 0.01:
        return vp_rgb

    x0, y0, sx, sy = transform
    overlay = Image.new("RGBA", (VP_W, VP_H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    f_tag = font_mono(13, bold=True)

    for b in boxes:
        bx0, by0, bx1, by1 = b["rect"]
        col = b["color"]
        dx0 = int(round((bx0 - x0) * sx))
        dy0 = int(round((by0 - y0) * sy))
        dx1 = int(round((bx1 - x0) * sx))
        dy1 = int(round((by1 - y0) * sy))

        # Clamp strictly inside viewport padding so borders never clip awkwardly
        dx0_c = max(6, min(VP_W - 7, dx0))
        dy0_c = max(6, min(VP_H - 7, dy0))
        dx1_c = max(6, min(VP_W - 7, dx1))
        dy1_c = max(6, min(VP_H - 7, dy1))
        if dx1_c - dx0_c < 30 or dy1_c - dy0_c < 20:
            continue

        a_line = int(round(235 * alpha_scale))
        a_fill = int(round(13 * alpha_scale))

        # Layered soft halo (ultra-fast, crisp, zero per-frame blur overhead)
        od.rounded_rectangle(
            [dx0_c - 3, dy0_c - 3, dx1_c + 3, dy1_c + 3],
            radius=15,
            outline=(col[0], col[1], col[2], int(round(45 * alpha_scale))),
            width=5,
        )
        od.rounded_rectangle(
            [dx0_c - 1, dy0_c - 1, dx1_c + 1, dy1_c + 1],
            radius=13,
            outline=(col[0], col[1], col[2], int(round(95 * alpha_scale))),
            width=4,
        )
        od.rounded_rectangle(
            [dx0_c, dy0_c, dx1_c, dy1_c],
            radius=12,
            fill=(col[0], col[1], col[2], a_fill),
            outline=(col[0], col[1], col[2], a_line),
            width=3,
        )

        label = b.get("label")
        # Only draw floating tag pill when box top edge has clean headroom above it (never overlap UI text inside card)
        if label and dy0 >= 32:
            bb = od.textbbox((0, 0), label, font=f_tag)
            tw = bb[2] - bb[0] + 20
            th = 24
            tx1 = min(VP_W - 14, dx1_c - 10)
            tx0 = max(14, tx1 - tw)
            ty0 = dy0_c - th - 6
            ty1 = ty0 + th
            od.rounded_rectangle(
                [tx0, ty0, tx1, ty1],
                radius=6,
                fill=(9, 14, 25, int(round(238 * alpha_scale))),
                outline=(col[0], col[1], col[2], a_line),
                width=1,
            )
            od.text(((tx0 + tx1) // 2, (ty0 + ty1) // 2), label, font=f_tag, fill=(col[0], col[1], col[2], a_line), anchor="mm")

    ov_arr = np.array(overlay, dtype=np.float32)
    a = ov_arr[:, :, 3:4] / 255.0
    out = vp_rgb.astype(np.float32) * (1.0 - a) + ov_arr[:, :, :3] * a
    return np.clip(out, 0, 255).astype(np.uint8)


# Scene choreography: every coordinate verified against the 4 Retina PNGs (2880xH)
SCENE_SPECS = {
    "intro_title": {
        "kind": "intro",
    },
    "overview_top": {
        "kind": "shot",
        "shot": "01",
        "cam0": (1440, 672, 2880),
        "cam1": (1440, 705, 2800),
        "boxes": [],
    },
    "overview_telemetry_zoom": {
        "kind": "shot",
        "shot": "01",
        "cam0": (1780, 485, 2120),
        "cam1": (1920, 445, 1920),
        "boxes": [
            {"rect": (2374, 22, 2848, 108), "color": EMERALD, "label": "LIVE WS + HONEST SNAPSHOT"},
            {"rect": (2142, 130, 2838, 414), "color": PURPLE, "label": "CHAIN 286623 · 2s FINALITY"},
        ],
    },
    "overview_brief_matrix": {
        "kind": "shot",
        "shot": "01",
        "cam0": (1440, 1020, 2880),
        "cam1": (1440, 1185, 2880),
        "boxes": [
            {"rect": (42, 448, 2838, 804), "color": CYAN, "label": "QUANT DESK BRIEF · 86/100"},
            {"rect": (42, 840, 1668, 1620), "color": EMERALD, "label": "107 PERPS / 48 SPOT · AVAX +7.17%"},
        ],
    },
    "basis_full": {
        "kind": "shot",
        "shot": "02",
        "cam0": (1440, 672, 2880),
        "cam1": (1440, 745, 2840),
        "boxes": [],
    },
    "basis_l2_zoom": {
        "kind": "shot",
        "shot": "02",
        "cam0": (960, 740, 1920),
        "cam1": (960, 1390, 1920),
        "boxes": [
            {"rect": (44, 324, 956, 1882), "color": CYAN},
            {"rect": (60, 1380, 940, 1525), "color": AMBER, "label": "200× MAXLEV IMPACT NOTIONAL"},
        ],
    },
    "basis_spot_zoom": {
        "kind": "shot",
        "shot": "02",
        "cam0": (1440, 880, 2060),
        "cam1": (1440, 1220, 1920),
        "boxes": [
            {"rect": (988, 324, 1894, 1004), "color": EMERALD, "label": "$1.71M TOP-15 DEPTH"},
            {"rect": (988, 1034, 1894, 1882), "color": CYAN, "label": "SPOT CLOB LEG · +5.1 bps BASIS"},
        ],
    },
    "basis_carry_zoom": {
        "kind": "shot",
        "shot": "02",
        "cam0": (1950, 860, 1860),
        "cam1": (1960, 1070, 1840),
        "boxes": [
            {"rect": (1960, 830, 2808, 1295), "color": EMERALD, "label": "+2.28% APY · 10.1d BREAKEVEN"},
        ],
    },
    "stress_full": {
        "kind": "shot",
        "shot": "03",
        "cam0": (1440, 672, 2880),
        "cam1": (1440, 725, 2820),
        "boxes": [],
    },
    "stress_metrics_zoom": {
        "kind": "shot",
        "shot": "03",
        "cam0": (1440, 625, 2880),
        "cam1": (1540, 665, 2680),
        "boxes": [
            {"rect": (2132, 336, 2808, 502), "color": ROSE, "label": "BASIS BLOWOUT (+180 bps)"},
            {"rect": (1156, 748, 2280, 982), "color": ROSE, "label": "99% CVaR -$21,125 · 48.0% LIQ RISK"},
        ],
    },
    "stress_charts_zoom": {
        "kind": "shot",
        "shot": "03",
        "cam0": (1440, 1540, 2880),
        "cam1": (1440, 1605, 2840),
        "boxes": [
            {"rect": (44, 1018, 1664, 2122), "color": CYAN, "label": "1,000-PATH EQUITY FAN (P5–P95)"},
            {"rect": (1698, 1624, 2836, 2122), "color": AMBER, "label": "LIVE SODEX MARGIN TIERS"},
        ],
    },
    "ssi_top": {
        "kind": "shot",
        "shot": "04",
        "cam0": (1440, 672, 2880),
        "cam1": (1440, 560, 2720),
        "boxes": [
            {"rect": (44, 174, 956, 478), "color": CYAN, "label": "MAG7.ssi · -36.6 bps vs iNAV"},
        ],
    },
    "ssi_drift_zoom": {
        "kind": "shot",
        "shot": "04",
        "cam0": (1080, 1180, 2160),
        "cam1": (1020, 1465, 2040),
        "boxes": [
            {"rect": (44, 838, 1666, 2070), "color": EMERALD, "label": "±0.8% BUFFER · 1.69% TURNOVER"},
        ],
    },
    "ssi_calldata_zoom": {
        "kind": "shot",
        "shot": "04",
        "cam0": (1700, 1345, 2360),
        "cam1": (1720, 1395, 2320),
        "boxes": [
            {"rect": (1698, 838, 2836, 1236), "color": EMERALD, "label": "CHAIN 286623 GAS · 0.00000084 SOSO"},
            {"rect": (1698, 1268, 2836, 2070), "color": PURPLE, "label": "AssetRebalancer.sol · 10^8 CALLDATA"},
        ],
    },
    "risk_gate_zoom": {
        "kind": "shot",
        "shot": "02",
        "cam0": (1930, 1340, 1900),
        "cam1": (1990, 1435, 1780),
        "boxes": [
            {"rect": (1956, 1298, 2816, 1865), "color": EMERALD, "label": "5-RULE RISK GATE · PASS"},
        ],
    },
    "blotter_zoom": {
        "kind": "shot",
        "shot": "01",
        "cam0": (1440, 2380, 2880),
        "cam1": (1440, 2478, 2880),
        "boxes": [
            {"rect": (42, 2556, 2838, 2978), "color": EMERALD, "label": "LIVE MTM PAPER BLOTTER · ZERO CUSTODY"},
        ],
    },
    "outro_proof": {
        "kind": "outro_1",
    },
    "outro_final": {
        "kind": "outro_2",
    },
}


def write_srt(cues: list[dict], out_path: Path) -> None:
    lines = []
    for idx, c in enumerate(cues, 1):
        t0 = fmt_srt_time(c["start"])
        t1 = fmt_srt_time(c["end"] + 0.08)
        body = "\n".join(c["sub_lines"])
        lines.append(f"{idx}\n{t0} --> {t1}\n{body}\n")
    out_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> None:
    t_wall0 = time.time()
    meta = json.loads((AUDIO_DIR / "timeline.json").read_text())
    total_dur = float(meta["total_duration"])
    chapters = meta["chapters"]
    cues = meta["cues"]
    master_m4a = AUDIO_DIR / "master_audio.m4a"

    write_srt(cues, OUT_SRT)
    print(f"Wrote SRT: {OUT_SRT}")

    # Load all 4 Retina screenshots as RGB numpy arrays
    print("Loading 4 Retina screenshots...")
    shots = {
        "01": np.array(Image.open(SHOT_DIR / "01-overview-desk.png").convert("RGB")),
        "02": np.array(Image.open(SHOT_DIR / "02-basis-orderbook.png").convert("RGB")),
        "03": np.array(Image.open(SHOT_DIR / "03-risk-stress-lab.png").convert("RGB")),
        "04": np.array(Image.open(SHOT_DIR / "04-ssi-rebalancer.png").convert("RGB")),
    }

    bg_canvas = build_background_canvas()
    vp_mask = build_viewport_mask()
    bg_vp_patch = bg_canvas[VP_Y : VP_Y + VP_H, VP_X : VP_X + VP_W].astype(np.float32) * (1.0 - vp_mask)

    intro_slate = render_intro_slate(shots["01"])
    outro_slate_1 = render_outro_slate(shots["01"], highlight_final=False)
    outro_slate_2 = render_outro_slate(shots["01"], highlight_final=True)

    # Pre-render burned-in subtitle overlays for all cues
    sub_overlays = {}
    for c in cues:
        sub_overlays[c["id"]] = prerender_subtitle_card(c["sub_lines"])

    # Assign contiguous visual intervals [vis_start, vis_end] to each cue
    segments = []
    for i, c in enumerate(cues):
        v_start = 0.0 if i == 0 else (cues[i - 1]["end"] + cues[i - 1]["pause_after"] * 0.55)
        v_end = total_dur if i == len(cues) - 1 else (c["end"] + c["pause_after"] * 0.55)
        segments.append({**c, "vis_start": v_start, "vis_end": v_end, "spec": SCENE_SPECS[c["scene"]]})

    def render_segment_vp(seg: dict, t: float, prev_seg: dict | None) -> np.ndarray:
        spec = seg["spec"]
        u_raw = (t - seg["vis_start"]) / max(0.001, seg["vis_end"] - seg["vis_start"])
        u = ease_in_out_cubic(u_raw)

        if spec["kind"] == "intro":
            # Gentle 1.0 -> 1.028 cinematic push-in on title slate
            scale = 1.0 + 0.028 * u
            vw = VP_W / scale
            vh = VP_H / scale
            x0 = (VP_W - vw) * 0.5
            y0 = (VP_H - vh) * 0.5
            M = np.array([[scale, 0.0, -x0 * scale], [0.0, scale, -y0 * scale]], dtype=np.float32)
            return cv2.warpAffine(intro_slate, M, (VP_W, VP_H), flags=cv2.INTER_CUBIC)

        if spec["kind"] in ("outro_1", "outro_2"):
            base_im = outro_slate_1 if spec["kind"] == "outro_1" else outro_slate_2
            scale = 1.0 + 0.018 * u
            vw = VP_W / scale
            vh = VP_H / scale
            x0 = (VP_W - vw) * 0.5
            y0 = (VP_H - vh) * 0.5
            M = np.array([[scale, 0.0, -x0 * scale], [0.0, scale, -y0 * scale]], dtype=np.float32)
            return cv2.warpAffine(base_im, M, (VP_W, VP_H), flags=cv2.INTER_CUBIC)

        # Screenshot scene with smooth camera glide from previous same-shot end position!
        shot_rgb = shots[spec["shot"]]
        c0 = spec["cam0"]
        c1 = spec["cam1"]

        glide_dur = 0.65
        if prev_seg is not None and prev_seg["spec"].get("shot") == spec["shot"] and (t - seg["vis_start"]) < glide_dur:
            # Smoothly glide camera from previous cue's end position into this cue's start position
            pc1 = prev_seg["spec"]["cam1"]
            g = ease_in_out_cubic((t - seg["vis_start"]) / glide_dur)
            cx = pc1[0] + (c0[0] - pc1[0]) * g
            cy = pc1[1] + (c0[1] - pc1[1]) * g
            vw = pc1[2] + (c0[2] - pc1[2]) * g
        else:
            # Adjust u for post-glide drift if we had a glide
            if prev_seg is not None and prev_seg["spec"].get("shot") == spec["shot"]:
                u2 = ease_in_out_cubic(
                    (t - (seg["vis_start"] + glide_dur))
                    / max(0.001, (seg["vis_end"] - (seg["vis_start"] + glide_dur)))
                )
            else:
                u2 = u
            cx = c0[0] + (c1[0] - c0[0]) * u2
            cy = c0[1] + (c1[1] - c0[1]) * u2
            vw = c0[2] + (c1[2] - c0[2]) * u2

        vp, xform = crop_screenshot_subpixel(shot_rgb, cx, cy, vw)

        # Smooth fade-in/out for glowing highlight boxes
        boxes = spec.get("boxes", [])
        if boxes:
            t_in = seg["vis_start"] + (0.55 if (prev_seg and prev_seg["spec"].get("shot") == spec["shot"]) else 0.35)
            t_out = seg["vis_end"] - 0.30
            a_in = smoothstep((t - t_in) / 0.38)
            a_out = smoothstep((seg["vis_end"] - t) / 0.30) if t > t_out else 1.0
            vp = draw_highlight_boxes(vp, xform, boxes, a_in * a_out)
        return vp

    n_frames = int(round(total_dur * FPS))
    print(f"Rendering {n_frames} frames ({total_dur:.2f}s @ {FPS}fps) -> {OUT_MP4}")

    # Launch ffmpeg encoder receiving raw RGB24 video on stdin + mastered AAC audio file
    ffmpeg_cmd = [
        FFMPEG,
        "-y",
        "-v",
        "warning",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-s",
        f"{W}x{H}",
        "-r",
        str(FPS),
        "-i",
        "pipe:0",
        "-i",
        str(master_m4a),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "libx264",
        "-profile:v",
        "high",
        "-level:v",
        "4.1",
        "-pix_fmt",
        "yuv420p",
        "-crf",
        "19",
        "-preset",
        "medium",
        "-maxrate",
        "1750k",
        "-bufsize",
        "3500k",
        "-g",
        "60",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-shortest",
        "-metadata",
        "title=BasisDesk — Autonomous One-Person On-Chain Quant & Risk Terminal",
        str(OUT_MP4),
    ]
    proc = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE)
    assert proc.stdin is not None

    xfade_half = 0.22  # 0.44s silky crossfade between different visual sources
    seg_idx = 0

    for f_idx in range(n_frames):
        t = f_idx / FPS

        # Advance active segment index
        while seg_idx < len(segments) - 1 and t >= segments[seg_idx]["vis_end"]:
            seg_idx += 1

        seg = segments[seg_idx]
        prev_seg = segments[seg_idx - 1] if seg_idx > 0 else None
        next_seg = segments[seg_idx + 1] if seg_idx < len(segments) - 1 else None

        # Determine active chapter
        active_ch = 5
        for ch in chapters:
            if t < ch["end"]:
                active_ch = ch["id"]
                break

        # Render main viewport (with crossfade when switching screenshots/slates)
        vp = render_segment_vp(seg, t, prev_seg)

        # Crossfade in from previous different source
        if prev_seg is not None:
            same_shot = (
                prev_seg["spec"].get("kind") == "shot"
                and seg["spec"].get("kind") == "shot"
                and prev_seg["spec"].get("shot") == seg["spec"].get("shot")
            )
            dt_in = t - seg["vis_start"]
            if not same_shot and 0.0 <= dt_in < xfade_half:
                vp_prev = render_segment_vp(prev_seg, seg["vis_start"], segments[seg_idx - 2] if seg_idx > 1 else None)
                alpha = smoothstep(0.5 + 0.5 * (dt_in / xfade_half))
                vp = np.clip(vp_prev.astype(np.float32) * (1.0 - alpha) + vp.astype(np.float32) * alpha, 0, 255).astype(np.uint8)

        # Crossfade out to next different source
        if next_seg is not None:
            same_shot_next = (
                next_seg["spec"].get("kind") == "shot"
                and seg["spec"].get("kind") == "shot"
                and next_seg["spec"].get("shot") == seg["spec"].get("shot")
            )
            dt_out = seg["vis_end"] - t
            if not same_shot_next and 0.0 <= dt_out < xfade_half:
                vp_next = render_segment_vp(next_seg, seg["vis_end"], seg)
                alpha = smoothstep(0.5 - 0.5 * (dt_out / xfade_half))
                vp = np.clip(vp.astype(np.float32) * (1.0 - alpha) + vp_next.astype(np.float32) * alpha, 0, 255).astype(np.uint8)

        # Compose full 1920x1080 frame
        frame = bg_canvas.copy()
        frame[0:HUD_H, :, :] = render_hud_strip(chapters, active_ch, t, total_dur)

        # Rounded-corner viewport blit
        vp_comp = vp.astype(np.float32) * vp_mask + bg_vp_patch
        frame[VP_Y : VP_Y + VP_H, VP_X : VP_X + VP_W, :] = np.clip(vp_comp, 0, 255).astype(np.uint8)

        # Burned-in synced subtitle overlay (y = 954..1074)
        active_sub = None
        sub_alpha = 0.0
        for c in cues:
            if c["start"] - 0.05 <= t <= c["end"] + 0.16:
                active_sub = c["id"]
                a_in = smoothstep((t - (c["start"] - 0.05)) / 0.14)
                a_out = smoothstep(((c["end"] + 0.16) - t) / 0.16)
                sub_alpha = min(a_in, a_out)
                break

        if active_sub is not None and sub_alpha > 0.01:
            ov = sub_overlays[active_sub].astype(np.float32)
            a = (ov[:, :, 3:4] / 255.0) * sub_alpha
            roi = frame[SUB_Y0 : SUB_Y0 + 120, :, :].astype(np.float32)
            frame[SUB_Y0 : SUB_Y0 + 120, :, :] = np.clip(roi * (1.0 - a) + ov[:, :, :3] * a, 0, 255).astype(np.uint8)

        # Subtle intro fade-in (0.45s) & outro fade-to-black (0.65s)
        if t < 0.45:
            f_a = smoothstep(t / 0.45)
            frame = (frame.astype(np.float32) * f_a).astype(np.uint8)
        elif t > total_dur - 0.65:
            f_a = smoothstep((total_dur - t) / 0.65)
            frame = (frame.astype(np.float32) * f_a).astype(np.uint8)

        proc.stdin.write(frame.tobytes())

        if (f_idx + 1) % 300 == 0 or f_idx == n_frames - 1:
            elapsed = time.time() - t_wall0
            pct = 100.0 * (f_idx + 1) / n_frames
            print(f"  [{pct:5.1f}%] frame {f_idx + 1}/{n_frames} ({elapsed:.1f}s elapsed)", flush=True)

    proc.stdin.close()
    ret = proc.wait()
    if ret != 0:
        raise RuntimeError(f"ffmpeg exited with code {ret}")
    print(f"Done in {time.time() - t_wall0:.1f}s -> {OUT_MP4}")


if __name__ == "__main__":
    main()
