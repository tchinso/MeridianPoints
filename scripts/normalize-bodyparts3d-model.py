"""Normalize the reviewed BodyParts3D skin GLB for the MeridianPoints viewer.

Input must be an *uncompressed* glTF 2.0 GLB containing one skin mesh with
POSITION and NORMAL float attributes. The upstream file is Draco-compressed;
decode it first with a standards-compliant glTF tool, then run this script.

The output is an adapted BodyParts3D asset. Keep the adjacent third-party
notice and distribute adaptations under CC BY-SA 2.1 Japan.
"""

from __future__ import annotations

import argparse
import json
import struct
from pathlib import Path

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "assets" / "models" / "meridian-anatomy-v1.glb"

# Measured source bounds from the reviewed BodyParts3D skin conversion.
SOURCE_MIN = np.array([-1.3389206, -3.5348651, -0.1873249], dtype=np.float32)
SOURCE_MAX = np.array([1.3337777, 3.1829646, 0.9706529], dtype=np.float32)
TARGET_HEIGHT = 1.80


def parse_glb(path: Path) -> tuple[dict, bytearray]:
    payload = path.read_bytes()
    magic, version, total_length = struct.unpack_from("<4sII", payload, 0)
    if magic != b"glTF" or version != 2 or total_length != len(payload):
        raise ValueError(f"{path} is not a valid glTF 2.0 GLB")

    json_length, json_type = struct.unpack_from("<I4s", payload, 12)
    if json_type != b"JSON":
        raise ValueError("GLB JSON chunk is missing")
    json_start = 20
    document = json.loads(payload[json_start : json_start + json_length])

    bin_header = json_start + json_length
    bin_length, bin_type = struct.unpack_from("<I4s", payload, bin_header)
    if bin_type != b"BIN\x00":
        raise ValueError("GLB binary chunk is missing")
    binary_start = bin_header + 8
    return document, bytearray(payload[binary_start : binary_start + bin_length])


def attribute_array(document: dict, binary: bytearray, accessor_index: int) -> np.ndarray:
    accessor = document["accessors"][accessor_index]
    if accessor.get("componentType") != 5126 or accessor.get("type") != "VEC3":
        raise ValueError(f"Accessor {accessor_index} must be a float VEC3")
    view = document["bufferViews"][accessor["bufferView"]]
    byte_offset = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    byte_stride = view.get("byteStride", 12)
    if byte_stride < 12 or byte_stride % 4:
        raise ValueError(f"Unsupported attribute stride: {byte_stride}")
    return np.ndarray(
        shape=(accessor["count"], 3),
        dtype="<f4",
        buffer=binary,
        offset=byte_offset,
        strides=(byte_stride, 4),
    )


def build_glb(document: dict, binary: bytearray, output: Path) -> None:
    document["buffers"] = [{"byteLength": len(binary)}]
    json_payload = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    json_payload += b" " * (-len(json_payload) % 4)
    binary += b"\x00" * (-len(binary) % 4)
    total_length = 12 + 8 + len(json_payload) + 8 + len(binary)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(
        struct.pack("<4sII", b"glTF", 2, total_length)
        + struct.pack("<I4s", len(json_payload), b"JSON")
        + json_payload
        + struct.pack("<I4s", len(binary), b"BIN\x00")
        + binary
    )


def normalise(input_path: Path, output_path: Path) -> None:
    document, binary = parse_glb(input_path)
    primitive = document["meshes"][0]["primitives"][0]
    positions = attribute_array(document, binary, primitive["attributes"]["POSITION"])
    normals = attribute_array(document, binary, primitive["attributes"]["NORMAL"])

    source_center = (SOURCE_MIN + SOURCE_MAX) / 2
    # This source is posed with arms down, so its X extent is body-and-hand
    # width rather than a T-pose arm span. Uniform scaling is intentional: it
    # keeps the adult face, shoulders, limbs, and bony landmarks anatomically
    # proportional instead of stretching the head and thorax to match a
    # different reference pose.
    scale = np.full(3, TARGET_HEIGHT / (SOURCE_MAX[1] - SOURCE_MIN[1]), dtype=np.float32)
    positions[:] = (positions - source_center) * scale
    positions[:, 1] += TARGET_HEIGHT / 2

    normals[:] = normals / scale
    normals[:] /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-7)

    position_accessor = document["accessors"][primitive["attributes"]["POSITION"]]
    position_accessor["min"] = positions.min(axis=0).astype(float).tolist()
    position_accessor["max"] = positions.max(axis=0).astype(float).tolist()

    document["asset"] = {
        "version": "2.0",
        "generator": "MeridianPoints BodyParts3D normalizer",
        "copyright": "BodyParts3D © The Database Center for Life Science, CC BY-SA 2.1 Japan; adapted for MeridianPoints. See assets/models/THIRD_PARTY_NOTICES.md.",
    }
    document["nodes"] = [
        {"name": "Skin_Body", "mesh": 0},
        {"name": "Layer_Skin", "children": [0]},
    ]
    document["scenes"] = [{"name": "MeridianPoints anatomical skin", "nodes": [1]}]
    document["scene"] = 0
    document["meshes"][0]["name"] = "Skin_Body"
    document["meshes"][0].pop("extras", None)
    document["materials"] = [
        {
            "name": "Warm anatomical skin",
            "pbrMetallicRoughness": {
                "baseColorFactor": [0.60, 0.36, 0.24, 1.0],
                "metallicFactor": 0.0,
                "roughnessFactor": 0.76,
            },
        }
    ]
    primitive["material"] = 0
    document.pop("images", None)
    document.pop("textures", None)
    document.pop("samplers", None)
    document.pop("extensionsUsed", None)
    document.pop("extensionsRequired", None)
    build_glb(document, binary, output_path)

    triangle_accessor = document["accessors"][primitive["indices"]]
    print(f"Wrote {output_path.relative_to(ROOT)}")
    print(f"Vertices: {len(positions):,}; triangles: {triangle_accessor['count'] // 3:,}; size: {output_path.stat().st_size / 1024 / 1024:.2f} MiB")
    print(f"Bounds: min={position_accessor['min']}, max={position_accessor['max']}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path, help="uncompressed BodyParts3D skin GLB")
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    arguments = parser.parse_args()
    normalise(arguments.input.resolve(), arguments.output.resolve())


if __name__ == "__main__":
    main()
