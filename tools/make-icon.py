# -*- coding: utf-8 -*-
"""
游戏管家 应用图标生成器（Steam 风格）

设计：
  - 透明底 + 深蓝渐变圆盘（Steam 品牌色系）
  - 左上柔光高光 + 内圈浅蓝细环，营造金属质感
  - 中央纯白手柄徽标（带投影与外发光），D-pad 与按键用低对比度细节刻出
  - 输出多尺寸 ICO（16/24/32/48/64/128/256），并附一张 PNG 预览

用法：
  python tools/make-icon.py            # 输出到 build/ 与 renderer/assets/
  python tools/make-icon.py --preview  # 额外输出 512px PNG 预览
"""

import os
import sys
import math

from PIL import Image, ImageDraw, ImageFilter, ImageChops, ImageOps

# ---------------------------------------------------------------- 品牌色
DISC_TOP = (46, 78, 112)      # #2E4E70 深蓝（顶部）
DISC_MID = (27, 40, 56)       # #1B2838 Steam 经典深蓝
DISC_BOT = (13, 20, 30)       # #0D141E 近黑（底部）
RING = (102, 192, 244)        # #66C0F4 Steam 亮蓝
WHITE = (248, 251, 255)       # 徽标白（略带冷调）
DETAIL = (176, 199, 224)      # 细节灰蓝（比机身暗一档，缩到 32px 仍可辨）

MASTER = 2048                 # 主图尺寸（后续 LANCZOS 降采样得到各尺寸）
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def make_disc(size):
    """深蓝渐变圆盘 + 左上柔光 + 内圈细环"""
    disc = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # 1) 三档线性渐变（上 -> 中 -> 下），逐行绘制后放大保证平滑
    steps = 512
    grad = Image.new("RGB", (1, steps))
    gp = grad.load()
    for y in range(steps):
        t = y / (steps - 1)
        if t < 0.5:
            gp[0, y] = lerp(DISC_TOP, DISC_MID, t / 0.5)
        else:
            gp[0, y] = lerp(DISC_MID, DISC_BOT, (t - 0.5) / 0.5)
    grad = grad.resize((size, size), Image.BILINEAR)
    disc.paste(grad, (0, 0))

    # 2) 左上柔光：径向渐变遮罩 * 白色
    glow = Image.radial_gradient("L").resize((size, size), Image.BILINEAR)
    glow = ImageOps.invert(glow)                       # 中心 255 -> 边缘 0
    glow = glow.point(lambda v: int(max(0, v - 90) * 255 / 165))   # 只保留中心一小块
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.10))
    highlight = Image.new("RGBA", (size, size), (255, 255, 255, 0))
    highlight.putalpha(glow.point(lambda v: int(v * 0.30)))
    disc = Image.alpha_composite(disc, highlight)

    # 3) 圆形裁切
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    disc.putalpha(ImageChops.multiply(disc.getchannel("A"), mask))

    # 4) 内圈细环（亮蓝，低透明度，贴着边缘）
    ring_layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inset = size * 0.055
    w = max(2, int(size * 0.013))
    ImageDraw.Draw(ring_layer).ellipse(
        (inset, inset, size - 1 - inset, size - 1 - inset),
        outline=RING + (78,), width=w,
    )
    ring_layer.putalpha(ImageChops.multiply(ring_layer.getchannel("A"), mask))
    disc = Image.alpha_composite(disc, ring_layer)

    return disc, mask


def _smooth_closed(pts, per=26):
    """用 Catmull-Rom 样条把控制点连成闭合平滑曲线（返回密集点列）"""
    n = len(pts)
    out = []
    for i in range(n):
        p0, p1, p2, p3 = pts[(i - 1) % n], pts[i], pts[(i + 1) % n], pts[(i + 2) % n]
        for j in range(per):
            t = j / per
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t
                       + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2
                       + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t
                       + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2
                       + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            out.append((x, y))
    return out


# 手柄剪影控制点（左半侧，u/v 均归一化；右半侧镜像得到）
GAMEPAD_HALF = [
    (0.500, 0.076),   # 顶部中央（略低于双肩）
    (0.390, 0.062),
    (0.292, 0.058),   # 左肩最高点
    (0.196, 0.080),
    (0.118, 0.152),   # 左肩外角
    (0.070, 0.272),
    (0.044, 0.406),
    (0.038, 0.545),   # 最宽处
    (0.056, 0.678),
    (0.096, 0.792),
    (0.152, 0.874),   # 握把外下缘
    (0.212, 0.926),   # 握把底部
    (0.268, 0.934),
    (0.320, 0.904),
    (0.366, 0.842),   # 握把内下缘
    (0.392, 0.756),
    (0.414, 0.676),
    (0.452, 0.626),
    (0.500, 0.608),   # 中央下缘（握把之间形成圆润 U 形）
]


def _shift_down(img, dy):
    """把 L 通道图像向下平移 dy 像素（不循环回绕）"""
    if dy == 0:
        return img
    out = Image.new("L", img.size, 0)
    out.paste(img.crop((0, 0, img.width, img.height - dy)), (0, dy))
    return out


def gamepad_layer(size):
    """
    手柄徽标：用 Catmull-Rom 闭曲线直接描出经典手柄剪影（双肩上耸、握把外扩下探、
    中央下缘呈圆润 U 形），填充竖向渐变（白 -> 浅灰蓝），
    再叠 D-pad / ABXY / 菜单键等低对比细节。
    """
    W = size * 0.600          # 徽标宽度
    H = W * 0.672             # 徽标高度（宽高比 ~1.49，接近真机正视比例）
    bx = (size - W) / 2
    by = (size - H) / 2 + size * 0.004

    def X(u):
        return bx + u * W

    def Y(v):
        return by + v * H

    # 1) 左半侧控制点 + 镜像 => 闭合剪影
    half = GAMEPAD_HALF
    pts = half + [(1.0 - u, v) for (u, v) in reversed(half[:-1])]
    poly = [(X(u), Y(v)) for (u, v) in _smooth_closed(pts)]

    silhouette = Image.new("L", (size, size), 0)
    ImageDraw.Draw(silhouette).polygon(poly, fill=255)

    # 2) 机身填竖向渐变，避免整块死白，更有材质感
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    steps = 256
    ramp = Image.new("RGB", (1, steps))
    rp = ramp.load()
    for y in range(steps):
        rp[0, y] = lerp(WHITE, (203, 221, 240), y / (steps - 1))
    ramp = ramp.resize((size, size), Image.BILINEAR)
    layer.paste(ramp, (0, 0), silhouette)

    d = ImageDraw.Draw(layer)

    # 细节尺寸统一用「占徽标宽度 W 的比例」表达，再换算到 v 轴（v 轴单位是 H）
    ratio = W / H          # 归一化 u 单位 -> 归一化 v 单位的换算系数

    # 3) D-pad（左）：十字
    dcx, dcy = 0.302, 0.322
    arm_u, thick_u = 0.058, 0.0205
    r = max(2, int(thick_u * W * 0.85))
    d.rounded_rectangle(
        (X(dcx - arm_u), Y(dcy - thick_u * ratio), X(dcx + arm_u), Y(dcy + thick_u * ratio)),
        radius=r, fill=DETAIL + (255,),
    )
    d.rounded_rectangle(
        (X(dcx - thick_u), Y(dcy - arm_u * ratio), X(dcx + thick_u), Y(dcy + arm_u * ratio)),
        radius=r, fill=DETAIL + (255,),
    )

    # 4) ABXY 四键（右）
    bcx, bcy = 0.698, 0.322
    br_u, dist_u = 0.0215, 0.059
    for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
        cx = bcx + dx * dist_u
        cy = bcy + dy * dist_u * ratio
        d.ellipse(
            (X(cx - br_u), Y(cy - br_u * ratio), X(cx + br_u), Y(cy + br_u * ratio)),
            fill=DETAIL + (255,),
        )

    # 5) 中央菜单键
    for cx in (0.470, 0.530):
        d.rounded_rectangle(
            (X(cx - 0.015), Y(0.330), X(cx + 0.015), Y(0.362)),
            radius=max(2, int(0.006 * W)), fill=DETAIL + (255,),
        )

    return layer


def compose(size):
    disc, mask = make_disc(size)
    emblem = gamepad_layer(size)

    # 徽标：外发光 + 投影，让白手柄从深蓝底上"浮"起来
    glow = emblem.getchannel("A").filter(ImageFilter.GaussianBlur(size * 0.045))
    glow_layer = Image.new("RGBA", (size, size), RING + (0,))
    glow_layer.putalpha(glow.point(lambda v: int(v * 0.42)))

    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sh_alpha = emblem.getchannel("A").filter(ImageFilter.GaussianBlur(size * 0.030))
    sh_alpha = _shift_down(sh_alpha, int(size * 0.018))
    shadow.putalpha(sh_alpha.point(lambda v: int(v * 0.45)))

    out = Image.alpha_composite(disc, glow_layer)
    out = Image.alpha_composite(out, shadow)
    out = Image.alpha_composite(out, emblem)

    # 全部限制在圆盘内
    out.putalpha(ImageChops.multiply(out.getchannel("A"), mask))
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    build_dir = os.path.join(root, "build")
    assets_dir = os.path.join(root, "renderer", "assets")
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)

    print("渲染主图 %dpx …" % MASTER)
    master = compose(MASTER)

    ico_path = os.path.join(build_dir, "icon.ico")
    master.save(ico_path, format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print("已输出 %s" % ico_path)

    # 256px PNG + 一份给渲染层做 favicon / 界面用
    png256 = master.resize((256, 256), Image.LANCZOS)
    png256.save(os.path.join(build_dir, "icon.png"))
    png256.save(os.path.join(assets_dir, "icon.png"))
    print("已输出 build/icon.png 与 renderer/assets/icon.png")

    # ICO 也放到 renderer/assets，保持与原工程一致
    master.save(os.path.join(assets_dir, "icon.ico"), format="ICO", sizes=[(s, s) for s in ICO_SIZES])
    print("已输出 renderer/assets/icon.ico")

    if "--preview" in sys.argv:
        master.resize((512, 512), Image.LANCZOS).save(os.path.join(build_dir, "icon-preview.png"))
        # 一排小尺寸，检查缩小后是否清晰
        gap, pad = 32, 20
        strip_w = pad * 2 + sum(s + gap for s in ICO_SIZES)
        strip = Image.new("RGBA", (strip_w, 160), (255, 255, 255, 255))
        x = pad
        for s in ICO_SIZES:
            im = master.resize((s, s), Image.LANCZOS)
            strip.alpha_composite(im, (x, 80 - s // 2))
            x += s + gap
        strip.save(os.path.join(build_dir, "icon-sizes.png"))
        print("已输出预览图")


if __name__ == "__main__":
    main()
