"""Convert Xbox 360 XNB (XNA 1.x, 'XNBx' v1) textures from the extracted ccgame into PNGs.

Usage: python3 tools/xnb_textures.py extracted assets/textures
"""
import re
import struct
import sys
from io import BytesIO
from pathlib import Path

from PIL import Image

# XNA 1.x SurfaceFormat values
FMT_COLOR = 1
FMT_DXT = {28: b"DXT1", 30: b"DXT3", 32: b"DXT5"}

NAME_RE = re.compile(rb"(?:Content\\[\x20-\x7e]+?\.(?:xnb|xgs|xsb|xwb)|Demo360\.exe|SkinnedModel\.dll)")


def read_manifest(extracted: Path) -> list[str]:
    """File N in the cab is the Nth name listed in XCabInfo.resources."""
    names = NAME_RE.findall((extracted / "XCabInfo.resources").read_bytes())
    return [n.decode().replace("\\", "/") for n in names]


class Reader:
    def __init__(self, data: bytes, pos: int = 0):
        self.data, self.pos = data, pos

    def u8(self) -> int:
        self.pos += 1
        return self.data[self.pos - 1]

    def i32(self) -> int:
        self.pos += 4
        return struct.unpack_from("<i", self.data, self.pos - 4)[0]

    def uleb(self) -> int:
        result = shift = 0
        while True:
            b = self.u8()
            result |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                return result

    def string(self) -> str:
        n = self.uleb()
        self.pos += n
        return self.data[self.pos - n:self.pos].decode()

    def bytes(self, n: int) -> bytes:
        self.pos += n
        return self.data[self.pos - n:self.pos]


def parse_header(data: bytes) -> tuple[Reader, list[str]]:
    if data[:4] != b"XNBx" or data[4] != 1:
        raise ValueError("not an XNA 1.x Xbox 360 XNB")
    if data[5] & 0x80:
        raise ValueError("compressed XNB not supported")
    r = Reader(data, 10)
    readers = []
    for _ in range(r.uleb()):
        readers.append(r.string())
        r.i32()  # reader version
    r.uleb()  # shared resource count
    return r, readers


def decode_surface(fmt: int, w: int, h: int, raw: bytes) -> Image.Image:
    if fmt == FMT_COLOR:
        # Xbox stores 32-bit ARGB big-endian, i.e. bytes A,R,G,B
        return Image.frombuffer("RGBA", (w, h), raw, "raw", "ARGB", 0, 1)
    if fmt in FMT_DXT:
        # DXT blocks are made of 16-bit big-endian words; swap to little-endian, wrap in a DDS
        swapped = bytearray(raw)
        swapped[0::2], swapped[1::2] = raw[1::2], raw[0::2]
        dds = (b"DDS " + struct.pack("<7I", 124, 0x1007, h, w, 0, 0, 0) + b"\0" * 44
               + struct.pack("<2I", 32, 4) + FMT_DXT[fmt] + b"\0" * 20
               + struct.pack("<I", 0x1000) + b"\0" * 16)
        return Image.open(BytesIO(dds + bytes(swapped))).convert("RGBA")
    raise ValueError(f"unsupported surface format {fmt}")


def read_texture2d(r: Reader) -> Image.Image:
    fmt, w, h, mips = r.i32(), r.i32(), r.i32(), r.i32()
    img = decode_surface(fmt, w, h, r.bytes(r.i32()))
    for _ in range(mips - 1):
        r.bytes(r.i32())
    return img


def read_texture_cube(r: Reader) -> list[Image.Image]:
    fmt, size, mips = r.i32(), r.i32(), r.i32()
    faces = []
    for _ in range(6):
        faces.append(decode_surface(fmt, size, size, r.bytes(r.i32())))
        for _ in range(mips - 1):
            r.bytes(r.i32())
    return faces


def convert(src: Path, out_base: Path) -> str:
    r, readers = parse_header(src.read_bytes())
    type_id = r.uleb()
    kind = readers[type_id - 1].split(".")[-1]
    out_base.parent.mkdir(parents=True, exist_ok=True)
    if kind == "Texture2DReader":
        read_texture2d(r).save(out_base.with_suffix(".png"))
        return kind
    if kind == "TextureCubeReader":
        # XNA CubeMapFace order: +X, -X, +Y, -Y, +Z, -Z
        for face, img in zip(["px", "nx", "py", "ny", "pz", "nz"], read_texture_cube(r)):
            img.save(out_base.with_name(f"{out_base.name}_{face}.png"))
        return kind
    if kind == "SpriteFontReader":
        r.uleb()  # nested Texture2D type id
        read_texture2d(r).save(out_base.with_suffix(".png"))
        return kind
    return f"skipped ({kind})"


def main() -> None:
    extracted, out = Path(sys.argv[1]), Path(sys.argv[2])
    for index, name in enumerate(read_manifest(extracted)):
        if not name.endswith(".xnb") or "/Effects/" in name or name.startswith("Content/Models/") and ".fbm/" not in name:
            continue
        rel = Path(name.removeprefix("Content/")).with_suffix("")
        try:
            print(f"{index:3} {name}: {convert(extracted / str(index), out / rel)}")
        except ValueError as e:
            print(f"{index:3} {name}: ERROR {e}")


if __name__ == "__main__":
    main()
