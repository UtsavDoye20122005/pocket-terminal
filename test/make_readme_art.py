# Renders the README images (hero banner + screen gallery) from the real screenshots.
# Run after make_screenshots.py:   python3 test/make_readme_art.py
import os, base64
from playwright.sync_api import sync_playwright
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(R, 'docs', 'screenshots'); OUT = os.path.join(R, 'docs', 'readme')
def img(name): return 'data:image/png;base64,' + base64.b64encode(open(f'{SHOTS}/{name}.png', 'rb').read()).decode()
icon = 'data:image/svg+xml;base64,' + base64.b64encode(open(f'{R}/docs/icon.svg', 'rb').read()).decode()
FONT = 'data:font/woff2;base64,' + base64.b64encode(open(f'{R}/docs/fonts/jetbrains-mono-latin-700-normal.woff2', 'rb').read()).decode()

BASE = f"""<style>
@font-face {{ font-family: JB; src: url({FONT}) format('woff2'); font-weight: 700; }}
* {{ box-sizing: border-box; margin: 0; }}
body {{ background: #0F1220; color: #E9E7F2; font-family: -apple-system, 'Inter', 'Segoe UI', Roboto, sans-serif; }}
.phone {{ width: 300px; border-radius: 44px; padding: 10px; background: #2A2F4A; box-shadow: 0 30px 80px rgba(0,0,0,.55), inset 0 0 0 2px #3A4062; }}
.phone img {{ display: block; width: 100%; border-radius: 34px; }}
</style>"""

HERO = BASE + f"""
<div style="width:1280px;height:640px;position:relative;overflow:hidden;background:radial-gradient(90% 90% at 75% 10%, #262D58 0%, #0F1220 62%)">
  <svg style="position:absolute;inset:0" width="1280" height="640">{''.join(f'<circle cx="{(i*137)%1280}" cy="{(i*89)%380}" r="{1 + (i%3)*0.5}" fill="#E9E7F2" opacity="{0.15 + (i%5)*0.08}"/>' for i in range(60))}</svg>
  <div style="position:absolute;left:80px;top:150px;width:560px">
    <img src="{icon}" width="76" height="76" style="display:block;margin-bottom:26px">
    <div style="font:700 64px/1.02 JB, monospace;letter-spacing:-1.5px">Pocket<br>Terminal</div>
    <p style="margin-top:22px;font-size:25px;line-height:1.4;color:#C9C7DA">Your computer's terminal on your phone.<br>From anywhere, even with the lid closed.</p>
    <p style="margin-top:22px;font-size:18px;line-height:1.5;color:#8D91AE">Peer-to-peer and end-to-end encrypted. No server to run.<br>Works on macOS and Windows.</p>
  </div>
  <div class="phone" style="position:absolute;right:300px;top:70px;transform:rotate(-4deg)"><img src="{img('terminal')}"></div>
  <div class="phone" style="position:absolute;right:40px;top:120px;transform:rotate(5deg)"><img src="{img('asleep')}"></div>
</div>"""

shots = [('pair', 'Approve each phone on the computer'), ('terminal', 'A real terminal, connected directly'), ('asleep', "Asleep? Send it anyway"), ('commands', 'Replies come back to you'), ('power', 'You decide how it sleeps')]
GALLERY = BASE + f"""
<div style="width:1640px;padding:56px 40px 48px;display:flex;gap:28px;justify-content:center;background:#0F1220">
  {''.join(f'<figure style="width:300px"><div class="phone" style="box-shadow:0 20px 50px rgba(0,0,0,.5), inset 0 0 0 2px #3A4062"><img src="{img(n)}"></div><figcaption style="margin-top:20px;text-align:center;font-size:20px;color:#C9C7DA">{c}</figcaption></figure>' for n, c in shots)}
</div>"""

with sync_playwright() as p:
    b = p.chromium.launch()
    for name, html, w, h in [('hero', HERO, 1280, 640), ('screens', GALLERY, 1640, 800)]:
        pg = b.new_page(viewport={'width': w, 'height': h}, device_scale_factor=2)
        pg.set_content(html); pg.wait_for_timeout(400)
        el = pg.locator('body > div').first
        el.screenshot(path=f'{OUT}/{name}.png')
    b.close()
print('done')
