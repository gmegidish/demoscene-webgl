"""Dump XNA 1.x SpriteFont glyph metrics to JSON (the glyph sheet PNG comes from xnb_textures.py).

Usage: python3 tools/xnb_fonts.py extracted assets/fonts
"""
import json
import sys
from pathlib import Path

from xnb_models import XnbReader
from xnb_textures import parse_header, read_manifest, read_texture2d


class FontReader(XnbReader):
    def raw(self, type_name: str):
        return {
            "Microsoft.Xna.Framework.Rectangle": lambda: [self.i32() for _ in range(4)],
            "System.Char": self.char,
            "System.Int32": self.i32,
        }[type_name]

    def char(self) -> str:
        # .NET BinaryReader.ReadChar: one UTF-8 encoded character
        first = self.data[self.pos]
        length = 1 if first < 0x80 else 2 if first < 0xE0 else 3 if first < 0xF0 else 4
        return self.bytes(length).decode("utf-8")

    def read_SpriteFontReader(self, _):
        self.obj()  # glyph sheet texture, already exported as PNG
        glyphs, cropping, char_map = self.obj(), self.obj(), self.obj()
        line_spacing = self.i32()
        spacing = self.f32()
        return {"glyphs": glyphs, "cropping": cropping, "characterMap": char_map,
                "lineSpacing": line_spacing, "spacing": spacing, "rest": len(self.data) - self.pos}

    def read_Texture2DReader(self, _):
        return read_texture2d(self)

    def read_ListReader(self, name):
        element = self.raw(name.split("[[")[1])
        return [element() for _ in range(self.u32())]

    def read_DictionaryReader(self, name):
        # The header truncates the generic name after the key type; the only dictionary here is <char, int>.
        key, value = self.raw(name.split("[[")[1]), self.i32
        return dict((key(), value()) for _ in range(self.u32()))


def main() -> None:
    extracted, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.mkdir(parents=True, exist_ok=True)
    for index, name in enumerate(read_manifest(extracted)):
        data = (extracted / str(index)).read_bytes() if name.endswith(".xnb") else b""
        if b"SpriteFontReader" not in data[:200]:
            continue
        r, readers = parse_header(data)
        font = FontReader(data, r.pos, readers).obj()
        stem = Path(name).stem
        (out / f"{stem}.json").write_text(json.dumps(font))
        print(stem, len(font["glyphs"]), "glyphs, lineSpacing", font["lineSpacing"], "spacing", font["spacing"], "bytes left", font["rest"])


if __name__ == "__main__":
    main()
