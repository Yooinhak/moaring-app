#!/usr/bin/env python3
"""
Play 스토어 스크린샷 생성기 — 폰 원본 캡처를 브랜드 배경·문구·폰 프레임으로 감싼다.

  store-assets/raw/1.png … 5.png  (폰에서 찍은 원본, 순서 = SHOTS 순서)
        ↓  python3 store-assets/make-screenshots.py
  store-assets/screenshots/01.png … (1080×1920 PNG)

Play 요구: 16:9 또는 9:16, 각 변 320~3840px, 장당 8MB 이하.
1080×1920 은 "각 변 1080px 이상 4장 이상" 프로모션 조건도 충족한다.
렌더링은 headless Chrome (feature-graphic 과 같은 방식) — 폰트는 앱과 같은 LINE Seed KR.
"""
import html
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent
APP = ROOT.parent
RAW = pathlib.Path(os.environ.get('RAW_DIR', ROOT / 'raw'))  # 시험용으로 바꿔 끼울 수 있게
OUT = pathlib.Path(os.environ.get('OUT_DIR', ROOT / 'screenshots'))
CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
W, H = 1080, 1920

# (헤드라인, 서브, 보여줄 쪽) — raw/1.* … raw/5.* 와 순서가 맞아야 한다.
# 폰 프레임은 화면의 일부만 보여준다: 'top' = 위쪽, 'bottom' = 아래쪽(아래에서 올라오는 시트용)
SHOTS = [
    ('보던 앱에서\n바로 저장', '공유하기 → 모아링, 앱 전환 없이', 'bottom'),
    ('흩어진 링크를\n한 곳에', '폴더로 깔끔하게 모아두세요', 'top'),
    ('제목·썸네일은\n알아서', '다시 찾기 쉬운 카드로 정리', 'top'),
    ('친구와 함께\n모으는 링크', '초대 링크 하나로 같이 써요', 'top'),
    ('누가 뭘 담았는지\n한눈에', '링크마다 담은 친구가 보여요', 'top'),
]

TEMPLATE = """<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
@font-face {{ font-family: LS; src: url('{font_bd}'); font-weight: 700; }}
@font-face {{ font-family: LS; src: url('{font_rg}'); font-weight: 400; }}
* {{ margin: 0; padding: 0; box-sizing: border-box; }}
html, body {{ width: {w}px; height: {h}px; overflow: hidden; }}
body {{
  font-family: LS, -apple-system, sans-serif; color: #fff; position: relative;
  background: linear-gradient(160deg, #B9AFF9 0%, #8B7EF2 46%, #6D5EF0 100%);
}}
.ring {{ position: absolute; border-radius: 50%; border: 3px solid rgba(255,255,255,.13); }}
.r1 {{ width: 620px; height: 620px; left: -230px; top: -250px; }}
.r2 {{ width: 820px; height: 820px; right: -380px; top: 900px; border-width: 2px; }}
.dot {{ position: absolute; border-radius: 50%; background: rgba(255,255,255,.22); }}
.copy {{ position: absolute; top: 132px; left: 0; right: 0; text-align: center; }}
.chip {{
  display: inline-flex; align-items: center; gap: 14px; padding: 12px 26px 12px 14px;
  background: rgba(255,255,255,.18); border: 1.5px solid rgba(255,255,255,.28); border-radius: 999px;
  font-size: 30px; font-weight: 700; letter-spacing: -.5px;
}}
.chip img {{ width: 46px; height: 46px; border-radius: 12px; }}
h1 {{
  margin-top: 40px; font-size: 92px; line-height: 1.2; font-weight: 700; letter-spacing: -3px;
  white-space: pre-line; text-shadow: 0 6px 30px rgba(36,31,82,.25);
}}
p {{ margin-top: 30px; font-size: 40px; font-weight: 400; color: rgba(255,255,255,.9); letter-spacing: -.8px; }}
.phone {{
  position: absolute; left: 50%; transform: translateX(-50%); top: 760px; width: 820px;
  padding: 20px; border-radius: 88px; background: #1E1A33;
  box-shadow: 0 50px 140px rgba(36,31,82,.5), 0 0 0 2px rgba(255,255,255,.08) inset;
}}
/* 760(폰 top) + 20(베젤) + 1140 = 1920 — 화면 끝이 캔버스 끝과 맞아 아래쪽 버튼이 잘리지 않음 */
.screen {{ position: relative; height: 1140px; border-radius: 68px; overflow: hidden; background: #fff; }}
.screen img {{ position: absolute; left: 0; width: 100%; {anchor}: 0; }}
</style></head><body>
<div class="ring r1"></div><div class="ring r2"></div>
<div class="dot" style="width:26px;height:26px;left:150px;top:560px"></div>
<div class="dot" style="width:16px;height:16px;right:170px;top:180px"></div>
<div class="dot" style="width:20px;height:20px;right:120px;top:640px"></div>
<div class="copy">
  <div class="chip"><img src="{icon}">모아링</div>
  <h1>{head}</h1>
  <p>{sub}</p>
</div>
<div class="phone"><div class="screen"><img src="{shot}"></div></div>
</body></html>"""


def main() -> int:
    raws = sorted(p for p in RAW.iterdir() if p.suffix.lower() in ('.png', '.jpg', '.jpeg'))
    if not raws:
        print(f'원본이 없어요: {RAW}/1.png … 에 폰 캡처를 넣어 주세요')
        return 1
    if len(raws) > len(SHOTS):
        print(f'원본 {len(raws)}장 중 앞 {len(SHOTS)}장만 씁니다 (문구가 {len(SHOTS)}개)')
    OUT.mkdir(exist_ok=True)
    for i, (raw, (head, sub, anchor)) in enumerate(zip(raws, SHOTS), start=1):
        page = ROOT / f'.shot-{i:02d}.html'
        page.write_text(TEMPLATE.format(
            w=W, h=H,
            font_bd=(APP / 'assets/fonts/LINESeedKR-Bd.ttf').as_uri(),
            font_rg=(APP / 'assets/fonts/LINESeedKR-Rg.ttf').as_uri(),
            icon=(APP / 'assets/favicon.png').as_uri(),
            shot=raw.resolve().as_uri(),
            head=html.escape(head), sub=html.escape(sub), anchor=anchor,
        ), encoding='utf-8')
        out = OUT / f'{i:02d}.png'
        subprocess.run([
            CHROME, '--headless', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files',
            '--force-device-scale-factor=1', f'--window-size={W},{H}', f'--screenshot={out}', page.as_uri(),
        ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        page.unlink()
        print(f'✅ {out}  ← {raw.name}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
