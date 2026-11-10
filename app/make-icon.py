"""生成应用图标 app/icon.ico（蓝紫渐变圆角方块 + 白色「课」字）。"""
from PIL import Image, ImageDraw, ImageFont
import os

S = 512
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
grad = Image.new('RGBA', (S, S))
gd = ImageDraw.Draw(grad)
for y in range(S):
    t = y / (S - 1)
    r = int(58 + (124 - 58) * t)
    g = int(110 + (58 - 110) * t)
    b = int(255 + (237 - 255) * t)
    gd.line([(0, y), (S, y)], fill=(r, g, b, 255))

mask = Image.new('L', (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
img.paste(grad, (0, 0), mask)

draw = ImageDraw.Draw(img)
font = None
for path in (r'C:\Windows\Fonts\msyhbd.ttc', r'C:\Windows\Fonts\msyh.ttc', r'C:\Windows\Fonts\simhei.ttf'):
    if os.path.exists(path):
        try:
            font = ImageFont.truetype(path, int(S * 0.56))
            break
        except Exception:
            continue
if font is None:
    font = ImageFont.load_default()
text = '课'
box = draw.textbbox((0, 0), text, font=font)
w, h = box[2] - box[0], box[3] - box[1]
draw.text(((S - w) / 2 - box[0], (S - h) / 2 - box[1] - S * 0.02), text, font=font, fill=(255, 255, 255, 255))

out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'icon.ico')
img.resize((256, 256), Image.LANCZOS).save(out, format='ICO', sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print('icon ->', out, os.path.getsize(out), 'bytes')
