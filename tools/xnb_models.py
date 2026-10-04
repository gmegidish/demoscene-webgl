"""Convert Xbox 360 XNB (XNA 1.x) Models, including SkinnedModel sample skinning data, to JSON + BIN.

Output per model: <name>.json (bones, meshes, parts, materials, skinning, attribute offsets) and
<name>.bin (little-endian Float32 vertex attributes and Uint32 indices) for web/src/modelLoader.js.

Usage: python3 tools/xnb_models.py extracted assets/models
"""
import json
import struct
import sys
from pathlib import Path

from xnb_textures import Reader, parse_header, read_manifest

# XNA 1.x VertexElementFormat -> (struct code for one big-endian component, component count, normalise divisor)
ELEMENT_FORMATS = {
    0: ("f", 1, None),  # Single
    1: ("f", 2, None),  # Vector2
    2: ("f", 3, None),  # Vector3
    3: ("f", 4, None),  # Vector4
    4: ("B", 4, 255.0),  # Color (ARGB on Xbox, reordered below)
    5: ("B", 4, None),  # Byte4
    6: ("h", 2, None),  # Short2
    7: ("h", 4, None),  # Short4
    8: ("h", 2, 32767.0),  # NormalizedShort2
    9: ("h", 4, 32767.0),  # NormalizedShort4
}
USAGES = {0: "position", 1: "blendWeight", 2: "blendIndices", 3: "normal", 5: "uv", 6: "tangent", 7: "binormal", 10: "color"}


class XnbReader(Reader):
    """ContentReader: polymorphic ReadObject keyed by the type-reader table in the XNB header."""

    def __init__(self, data: bytes, pos: int, readers: list[str]):
        super().__init__(data, pos)
        self.readers = [r.split(",")[0] for r in readers]
        self.bone_count = 0

    def f32(self) -> float:
        self.pos += 4
        return struct.unpack_from("<f", self.data, self.pos - 4)[0]

    def u32(self) -> int:
        self.pos += 4
        return struct.unpack_from("<I", self.data, self.pos - 4)[0]

    def i64(self) -> int:
        self.pos += 8
        return struct.unpack_from("<q", self.data, self.pos - 8)[0]

    def floats(self, n: int) -> list[float]:
        return [self.f32() for _ in range(n)]

    def obj(self):
        type_id = self.uleb()
        if type_id == 0:
            return None
        name = self.readers[type_id - 1]
        short = name.split("`")[0].split(".")[-1]
        handler = getattr(self, "read_" + short, None)
        if handler is None:
            raise ValueError(f"no handler for {name}")
        return handler(name)

    def read_StringReader(self, _):
        return self.string()

    def read_Int32Reader(self, _):
        return self.i32()

    def read_TimeSpanReader(self, _):
        return self.i64() / 10_000_000  # ticks -> seconds

    def read_MatrixReader(self, _):
        return self.floats(16)

    def read_ListReader(self, name):
        # Value-type elements are stored raw (no type id); reference types go through ReadObject.
        element = name.split("[[")[1]
        raw = {"Microsoft.Xna.Framework.Matrix": lambda: self.floats(16), "System.Int32": self.i32}.get(element)
        return [raw() if raw else self.obj() for _ in range(self.u32())]

    def read_DictionaryReader(self, _):
        return {self.obj(): self.obj() for _ in range(self.u32())}

    def read_ExternalReferenceReader(self, _):
        return {"external": self.string()}

    def read_SkinningDataReader(self, _):
        return {"clips": self.obj(), "bindPose": self.obj(), "inverseBindPose": self.obj(), "hierarchy": self.obj()}

    def read_AnimationClipReader(self, _):
        return {"duration": self.obj(), "keyframes": self.obj()}

    def read_KeyframeReader(self, _):
        return [self.obj(), self.obj(), self.obj()]  # bone, time, transform

    def read_VertexDeclarationReader(self, _):
        elements = []
        for _ in range(self.u32()):
            stream, offset = struct.unpack_from("<HH", self.data, self.pos)
            fmt, method, usage, index = self.data[self.pos + 4:self.pos + 8]
            self.pos += 8
            elements.append({"stream": stream, "offset": offset, "format": fmt, "usage": usage, "index": index})
        return elements

    def read_VertexBufferReader(self, _):
        return self.bytes(self.u32())

    def read_IndexBufferReader(self, _):
        is16 = self.u8() != 0
        raw = self.bytes(self.u32())
        fmt = ">%dH" % (len(raw) // 2) if is16 else ">%dI" % (len(raw) // 4)
        return list(struct.unpack(fmt, raw))

    def read_BasicEffectReader(self, _):
        texture = self.string()
        diffuse, emissive, specular = self.floats(3), self.floats(3), self.floats(3)
        return {"type": "basic", "texture": texture, "diffuse": diffuse, "emissive": emissive,
                "specular": specular, "specularPower": self.f32(), "alpha": self.f32(), "vertexColor": self.u8() != 0}

    def read_EffectMaterialReader(self, _):
        effect = self.string()
        return {"type": "material", "effect": effect, "parameters": self.obj()}

    def read_TextureReader(self, name):
        raise ValueError("embedded texture not supported")

    def bone_ref(self) -> int:
        """Bone index, or -1 for null."""
        v = self.u8() if self.bone_count < 255 else self.u32()
        return v - 1

    def read_ModelReader(self, _):
        self.bone_count = self.u32()
        bones = [{"name": self.obj(), "transform": self.floats(16)} for _ in range(self.bone_count)]
        for bone in bones:
            bone["parent"] = self.bone_ref()
            bone["children"] = [self.bone_ref() for _ in range(self.u32())]
        # XNA 1.x stores vertex declarations once per model; parts reference them by index.
        declarations = [self.obj() for _ in range(self.u32())]
        meshes = []
        for _ in range(self.u32()):
            mesh = {"name": self.obj(), "parentBone": self.bone_ref(), "boundingSphere": self.floats(4)}
            mesh["vertexBuffer"] = self.obj()
            mesh["indexBuffer"] = self.obj()
            mesh["tag"] = self.obj()
            mesh["parts"] = []
            for _ in range(self.u32()):
                part = {
                    "streamOffset": self.u32(), "baseVertex": self.u32(), "numVertices": self.u32(),
                    "startIndex": self.u32(), "primitiveCount": self.u32(),
                }
                part["declaration"] = declarations[self.u32()]
                part["tag"] = self.obj()
                part["effect"] = self.uleb() - 1  # shared resource index
                mesh["parts"].append(part)
            meshes.append(mesh)
        return {"bones": bones, "meshes": meshes, "root": self.bone_ref(), "tag": self.obj()}


def stride_of(decl: list[dict]) -> int:
    end = 0
    for e in decl:
        code, n, _ = ELEMENT_FORMATS[e["format"]]
        end = max(end, e["offset"] + struct.calcsize(code) * n)
    return end


def decode_part_vertices(vb: bytes, part: dict) -> dict[str, list[float]]:
    """Decode a part's big-endian interleaved vertices into per-attribute float lists."""
    decl = part["declaration"]
    stride = stride_of(decl)
    first = part["streamOffset"] // stride + part["baseVertex"]
    attrs: dict[str, list[float]] = {}
    for e in decl:
        code, n, norm = ELEMENT_FORMATS[e["format"]]
        name = USAGES.get(e["usage"], f"usage{e['usage']}") + (str(e["index"]) if e["index"] else "")
        out = attrs.setdefault(name, [])
        fmt = ">" + code * n
        for v in range(first, first + part["numVertices"]):
            vals = struct.unpack_from(fmt, vb, v * stride + e["offset"])
            if e["format"] == 4:
                a, r, g, b = vals
                vals = (r, g, b, a)
            elif e["format"] == 5:
                vals = vals[::-1]  # Byte4 is a packed big-endian dword: x lives in the last byte
            out.extend(x / norm for x in vals) if norm else out.extend(vals)
    return attrs


def convert(src: Path, out_dir: Path, name: str) -> str:
    data = src.read_bytes()
    r, readers = parse_header(data)
    reader = XnbReader(data, r.pos, readers)
    model = reader.obj()
    # Shared resources (the parts' effects) follow the primary object and run to end of file.
    shared = []
    while reader.pos < len(data):
        shared.append(reader.obj())

    blob = bytearray()

    def push(values: list[float], kind: str) -> dict:
        offset = len(blob)
        blob.extend(struct.pack(f"<{len(values)}{'f' if kind == 'f32' else 'I'}", *values))
        return {"offset": offset, "count": len(values), "type": kind}

    meshes = []
    for mesh in model["meshes"]:
        parts = []
        for part in mesh["parts"]:
            attrs = decode_part_vertices(mesh["vertexBuffer"], part)
            indices = mesh["indexBuffer"][part["startIndex"]:part["startIndex"] + part["primitiveCount"] * 3]
            parts.append({
                "attributes": {k: push(v, "f32") for k, v in attrs.items()},
                "sizes": {k: len(v) // part["numVertices"] for k, v in attrs.items()},
                "indices": push(indices, "u32"),
                "material": shared[part["effect"]] if part["effect"] >= 0 else None,
            })
        meshes.append({"name": mesh["name"], "parentBone": mesh["parentBone"], "parts": parts})

    out = {"bones": model["bones"], "root": model["root"], "meshes": meshes, "skinning": model["tag"]}
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"{name}.json").write_text(json.dumps(out))
    (out_dir / f"{name}.bin").write_bytes(blob)
    verts = sum(p["attributes"]["position"]["count"] // 3 for m in meshes for p in m["parts"])
    clips = list(model["tag"]["clips"].keys()) if isinstance(model["tag"], dict) else []
    return f"{len(model['bones'])} bones, {len(meshes)} meshes, {verts} verts, clips={clips}"


def main() -> None:
    extracted, out = Path(sys.argv[1]), Path(sys.argv[2])
    for index, name in enumerate(read_manifest(extracted)):
        if name.startswith("Content/Models/") and ".fbm/" not in name:
            stem = Path(name).stem
            print(f"{stem}: {convert(extracted / str(index), out, stem)}")


if __name__ == "__main__":
    main()
