# -*- coding: utf-8 -*-
"""生成一张抽象的深色渐变占位底图（用户可随时替换成自己的照片）。"""
import numpy as np
from PIL import Image, ImageFilter

W, H = 1920, 1080
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)

base = np.zeros((H, W, 3), np.float32)
base[..., 0] = 9.0
base[..., 1] = 13.0
base[..., 2] = 30.0

# (中心x, 中心y, 横向半径, 纵向半径, 颜色, 强度)
blobs = [
    (0.20, 0.10, 0.55, 0.45, (56, 104, 210), 1.00),
    (0.82, 0.22, 0.50, 0.42, (108, 66, 170), 0.70),
    (0.55, 0.95, 0.70, 0.50, (24, 128, 138), 0.45),
    (0.05, 0.80, 0.45, 0.45, (32, 44, 96), 0.85),
    (0.45, 0.42, 0.30, 0.25, (70, 90, 160), 0.35),
]

for cx, cy, rx, ry, color, strength in blobs:
    d = ((xx / W - cx) / rx) ** 2 + ((yy / H - cy) / ry) ** 2
    g = np.exp(-d * 2.0) * strength
    base += g[..., None] * np.array(color, np.float32) * 0.55

# 暗角：四周压暗，让中间的文字更突出
vx = (xx - W / 2) / (W / 2)
vy = (yy - H / 2) / (H / 2)
vignette = np.clip(1.0 - 0.40 * (vx ** 2 + vy ** 2), 0.50, 1.0)
base *= vignette[..., None]

# 一点细腻的噪点，避免大面积渐变出现色带
rng = np.random.default_rng(20261114)
base += rng.normal(0, 2.0, (H, W, 1))

img = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8), "RGB")
img = img.filter(ImageFilter.GaussianBlur(1.2))
img.save("images/bg.jpg", "JPEG", quality=90, optimize=True, progressive=True)
print("saved images/bg.jpg", img.size)
