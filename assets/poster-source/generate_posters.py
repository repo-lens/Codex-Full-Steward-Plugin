#!/usr/bin/env python3
from pathlib import Path
import math

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"
SCREENSHOT = ASSETS / "guardian-ui.png"
LATIN = "/System/Library/Fonts/Avenir Next.ttc"
CJK = "/System/Library/Fonts/Hiragino Sans GB.ttc"
SCALE = 2

COLORS = {
    "bg0": "#040a11",
    "bg1": "#071724",
    "bg2": "#0b2232",
    "panel": "#0d1722",
    "line": "#173247",
    "cyan": "#4fd1e8",
    "blue": "#62a8ff",
    "green": "#69d69f",
    "amber": "#f0bd62",
    "white": "#f4f8fc",
    "muted": "#91a4b7",
    "red": "#ff6666",
}


def font(size, weight="regular", cjk=False):
    path = CJK if cjk else LATIN
    index = 2 if cjk else {"bold": 0, "demi": 2, "medium": 5, "regular": 7}[weight]
    return ImageFont.truetype(path, int(size * SCALE), index=index)


def px(value):
    return int(round(value * SCALE))


def rgba(hex_color, alpha=255):
    hex_color = hex_color.lstrip("#")
    return tuple(int(hex_color[i:i + 2], 16) for i in (0, 2, 4)) + (alpha,)


def create_canvas(width, height):
    w, h = px(width), px(height)
    image = Image.new("RGBA", (w, h), rgba(COLORS["bg0"]))
    top = Image.new("RGBA", (1, h))
    for y in range(h):
        t = y / max(1, h - 1)
        if t < 0.55:
            u = t / 0.55
            color = tuple(int(rgba(COLORS["bg0"])[i] * (1 - u) + rgba(COLORS["bg2"])[i] * u) for i in range(3)) + (255,)
        else:
            u = (t - 0.55) / 0.45
            color = tuple(int(rgba(COLORS["bg2"])[i] * (1 - u) + rgba(COLORS["bg0"])[i] * u) for i in range(3)) + (255,)
        top.putpixel((0, y), color)
    image.alpha_composite(top.resize((w, h)))
    return image


def add_glow(image, center, radius, color, opacity=90):
    w, h = image.size
    glow = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    cx, cy = px(center[0]), px(center[1])
    r = px(radius)
    draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=rgba(color, opacity))
    glow = glow.filter(ImageFilter.GaussianBlur(px(42)))
    image.alpha_composite(glow)


def add_grid(image):
    draw = ImageDraw.Draw(image, "RGBA")
    w, h = image.size
    step = px(42)
    for x in range(0, w, step):
        draw.line((x, 0, x, h), fill=rgba(COLORS["line"], 95), width=max(1, px(0.5)))
    for y in range(0, h, step):
        draw.line((0, y, w, y), fill=rgba(COLORS["line"], 80), width=max(1, px(0.5)))
    for x in range(0, w, step * 4):
        for y in range(0, h, step * 4):
            draw.ellipse((x - px(1.3), y - px(1.3), x + px(1.3), y + px(1.3)), fill=rgba(COLORS["cyan"], 90))


def add_scanlines(image):
    draw = ImageDraw.Draw(image, "RGBA")
    w, h = image.size
    for y in range(0, h, px(6)):
        draw.line((0, y, w, y), fill=(255, 255, 255, 7), width=1)


def text(draw, xy, value, size, weight="regular", fill=None, cjk=False, anchor=None):
    draw.text((px(xy[0]), px(xy[1])), value, font=font(size, weight, cjk), fill=rgba(fill or COLORS["white"]), anchor=anchor)


def rounded(draw, box, radius, fill=None, outline=None, width=1):
    draw.rounded_rectangle(tuple(px(v) for v in box), radius=px(radius), fill=rgba(fill) if fill else None, outline=rgba(outline) if outline else None, width=px(width))


def pill(draw, x, y, label, color):
    f = font(12, "demi")
    bbox = draw.textbbox((0, 0), label, font=f)
    width = (bbox[2] - bbox[0]) / SCALE + 24
    rounded(draw, (x, y, x + width, y + 30), 15, fill="#0b1823", outline=color, width=1)
    draw.text((px(x + 12), px(y + 7)), label, font=f, fill=rgba(color))


def paste_screenshot(image, height, x, y, border_color=None):
    shot = Image.open(SCREENSHOT).convert("RGBA")
    width = int(shot.width * (px(height) / shot.height))
    shot = shot.resize((width, px(height)), Image.Resampling.LANCZOS)
    mask = Image.new("L", shot.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((0, 0, shot.width, shot.height), radius=px(18), fill=255)
    shadow = Image.new("RGBA", (shot.width + px(80), shot.height + px(80)), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle((px(40), px(40), shot.width + px(40), shot.height + px(40)), radius=px(18), fill=(0, 0, 0, 170))
    shadow = shadow.filter(ImageFilter.GaussianBlur(px(24)))
    image.alpha_composite(shadow, (px(x) - px(40), px(y) - px(40)))
    image.paste(shot, (px(x), px(y)), mask)
    if border_color:
        frame = Image.new("RGBA", image.size, (0, 0, 0, 0))
        frame_draw = ImageDraw.Draw(frame)
        frame_draw.rounded_rectangle((px(x), px(y), px(x + width / SCALE), px(y + height)), radius=px(18), outline=rgba(border_color, 150), width=px(1))
        image.alpha_composite(frame)


def draw_flow(draw, x, y, width, labels):
    draw.line((px(x), px(y), px(x + width), px(y)), fill=rgba(COLORS["line"]), width=px(2))
    step = width / (len(labels) - 1)
    for i, label in enumerate(labels):
        cx = x + i * step
        color = [COLORS["cyan"], COLORS["blue"], COLORS["amber"], COLORS["green"]][i]
        draw.ellipse((px(cx - 6), px(y - 6), px(cx + 6), px(y + 6)), fill=rgba(color), outline=rgba(COLORS["white"], 160), width=1)
        text(draw, (cx, y + 18), label, 13, "demi", color, anchor="ma")


def make_horizontal():
    width, height = 1280, 640
    image = create_canvas(width, height)
    add_glow(image, (1120, 110), 280, COLORS["cyan"], 55)
    add_glow(image, (430, 610), 320, COLORS["blue"], 36)
    add_glow(image, (890, 520), 220, COLORS["amber"], 24)
    add_grid(image)
    draw = ImageDraw.Draw(image, "RGBA")

    rounded(draw, (40, 36, 1240, 604), 24, fill=None, outline="#21445c", width=1)
    text(draw, (76, 64), "STEWARD-FIRST CODEX WORKFLOW", 14, "demi", COLORS["cyan"])
    text(draw, (76, 104), "Codex Full", 64, "bold")
    text(draw, (76, 172), "Steward Plugin", 64, "bold")
    text(draw, (78, 258), "Review. Decide. Plan. Deliver.", 25, "demi", COLORS["blue"])
    text(draw, (78, 307), "管家先判断方向，计划板再把下一步变成行动。", 20, "regular", COLORS["white"], cjk=True)
    text(draw, (78, 340), "429 自动恢复只是可选保险，不定义产品。", 20, "regular", COLORS["white"], cjk=True)

    pill(draw, 78, 398, "Steward Review", COLORS["cyan"])
    pill(draw, 214, 398, "Next-Step Plan", COLORS["blue"])
    pill(draw, 365, 398, "Plan Execution", COLORS["amber"])
    pill(draw, 514, 398, "Verified Delivery", COLORS["green"])

    rounded(draw, (78, 458, 670, 560), 14, fill="#09151f", outline="#1e4057", width=1)
    text(draw, (98, 476), " POLICY ENGINE ", 11, "demi", COLORS["muted"])
    draw_flow(draw, 118, 514, 510, ["Review", "Decide", "Plan", "Deliver"])
    text(draw, (78, 578), "Built By Yang YiZhu", 13, "medium", COLORS["muted"])

    # Right-side product panel and HUD rings
    draw.arc((px(842), px(38), px(1260), px(456)), 190, 350, fill=rgba(COLORS["cyan"], 120), width=px(2))
    draw.arc((px(880), px(20), px(1260), px(400)), 200, 330, fill=rgba(COLORS["amber"], 90), width=px(1))
    paste_screenshot(image, 510, 810, 86, COLORS["cyan"])
    for x, y, color in [(846, 102, COLORS["cyan"]), (1220, 98, COLORS["amber"]), (858, 520, COLORS["blue"])]:
        draw.ellipse((px(x - 4), px(y - 4), px(x + 4), px(y + 4)), fill=rgba(color, 190))

    add_scanlines(image)
    image = image.resize((width, height), Image.Resampling.LANCZOS).convert("RGB")
    image.save(ASSETS / "poster-horizontal.png", quality=95)


def make_vertical():
    width, height = 1080, 1440
    image = create_canvas(width, height)
    add_glow(image, (840, 170), 380, COLORS["cyan"], 48)
    add_glow(image, (180, 960), 420, COLORS["blue"], 32)
    add_glow(image, (820, 1260), 340, COLORS["amber"], 25)
    add_grid(image)
    draw = ImageDraw.Draw(image, "RGBA")

    rounded(draw, (48, 48, 1032, 1392), 28, fill=None, outline="#21445c", width=1)
    text(draw, (82, 82), "FULL STEWARD / V2.0.2", 15, "demi", COLORS["cyan"])
    text(draw, (82, 130), "Codex Full", 84, "bold")
    text(draw, (82, 222), "Steward", 84, "bold")
    text(draw, (82, 314), "Plugin", 84, "bold")
    text(draw, (86, 430), "Your Codex task steward.", 28, "demi", COLORS["blue"])
    text(draw, (86, 474), "从审核到交付，把每一轮任务纳入完整治理。", 21, "regular", COLORS["white"], cjk=True)

    labels = [
        ("01", "Review", "Read the real latest result"),
        ("02", "Decide", "Classify risk and required checks"),
        ("03", "Plan", "Validate and write back a clean next step"),
        ("04", "Deliver", "Verify backup before conservative cleanup"),
    ]
    y = 566
    for code, title, detail in labels:
        color = [COLORS["cyan"], COLORS["blue"], COLORS["amber"], COLORS["green"]][int(code) - 1]
        rounded(draw, (82, y, 520, y + 112), 14, fill="#09151f", outline="#1c3a4f", width=1)
        text(draw, (104, y + 20), code, 13, "demi", color)
        text(draw, (154, y + 16), title, 24, "bold", color)
        text(draw, (154, y + 54), detail, 14, "medium", COLORS["muted"])
        if code != "04":
            draw.line((px(122), px(y + 112), px(122), px(y + 150)), fill=rgba(COLORS["line"]), width=px(2))
        y += 150

    paste_screenshot(image, 620, 535, 610, COLORS["cyan"])
    draw.arc((px(460), px(430), px(1030), px(1000)), 180, 350, fill=rgba(COLORS["cyan"], 90), width=px(2))
    text(draw, (82, 1200), "Quality Gates · Model Fallback", 18, "demi", COLORS["white"])
    text(draw, (82, 1232), "Plan Execution · Verified Delivery", 18, "demi", COLORS["white"])

    rounded(draw, (82, 1286, 998, 1352), 18, fill="#0a1822", outline="#28546d", width=1)
    text(draw, (108, 1304), "Built By Yang YiZhu", 18, "demi", COLORS["white"])
    text(draw, (972, 1304), "LOCAL-FIRST", 14, "demi", COLORS["cyan"], anchor="ra")

    add_scanlines(image)
    image = image.resize((width, height), Image.Resampling.LANCZOS).convert("RGB")
    image.save(ASSETS / "poster-vertical.png", quality=95)


if __name__ == "__main__":
    ASSETS.mkdir(parents=True, exist_ok=True)
    make_horizontal()
    make_vertical()
    print("Generated assets/poster-horizontal.png and assets/poster-vertical.png")
