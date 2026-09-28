from PIL import Image
import os

im = Image.open("animacao.webp")
os.makedirs("frames", exist_ok=True)

total = im.n_frames
for i in range(total):
    im.seek(i)
    im.convert("RGB").save(f"frames/frame-{i+1:04d}.webp", quality=80)

print("Frames gerados:", total)