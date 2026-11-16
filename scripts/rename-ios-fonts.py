"""iOS 임베드용 LINE Seed 사본 생성 — PostScript 이름을 코드의 fontFamily 와 맞춘다.

사용: (레포 루트에서) python -I scripts/rename-ios-fonts.py   # fontTools 필요
원본 PostScript 이름(LINESeedSansKR-Regular/Bold) ≠ 코드의 'LINESeedKR'/'LINESeedKR-Bold'.
iOS 공유 확장은 런타임 폰트 로드가 안 돼 임베드 폰트를 PostScript 이름으로 찾는다.
"""
from pathlib import Path

from fontTools.ttLib import TTFont

SOURCES = {
    "assets/fonts/LINESeedKR-Rg.ttf": "LINESeedKR",
    "assets/fonts/LINESeedKR-Bd.ttf": "LINESeedKR-Bold",
}
OUT_DIR = Path("assets/fonts/ios")

OUT_DIR.mkdir(parents=True, exist_ok=True)
for src, name in SOURCES.items():
    font = TTFont(src)
    table = font["name"]
    # 타이포그래픽 패밀리(16/17)가 남으면 두 파일이 한 패밀리로 묶여 이름 매칭이 흔들린다
    table.names = [n for n in table.names if n.nameID not in (16, 17)]
    for name_id, value in ((1, name), (2, "Regular"), (3, name), (4, name), (6, name)):
        table.setName(value, name_id, 3, 1, 0x409)  # Windows
        table.setName(value, name_id, 1, 0, 0)  # Mac
    out = OUT_DIR / f"{name}.ttf"
    font.save(out)
    print(f"{src} -> {out} (PostScript: {name})")
