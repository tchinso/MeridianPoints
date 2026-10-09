/**
 * Source-derived location relationships, independent of route progress keys.
 * This verifies relative geometry, not clinical accuracy of the base landmarks.
 * Reference: assets/json/meridians.json and WHO Standard Acupuncture Point
 * Locations (regional B-cun measurements and named intercostal levels):
 * https://iris.who.int/bitstream/handle/10665/353407/9789290613831-eng.pdf
 * Run after generation: node scripts/test-acupoint-coordinates.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataset = JSON.parse(fs.readFileSync(path.join(root, "assets/json/acupoint-3d.json"), "utf8"));
const epsilon = 0.000002;
let checks = 0;

function instance(id, side = "left") {
  const point = dataset.points[id];
  assert.ok(point, `Missing source point ${id}`);
  const result = point.instances.find((value) => value.laterality === (point.laterality === "midline" ? "midline" : side));
  assert.ok(result, `Missing ${side} instance for ${id}`);
  return result;
}

function close(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, received ${actual}`);
  checks += 1;
}

const position = (id, side = "left") => instance(id, side).anchor.position;
const y = (id) => position(id)[1];

// Read the model's actual dimple vertices rather than validating the CV8
// coordinate against another copy of the generator's landmark constant.
// Existing surface audits cover triangle reconstruction and model identity.
function skinGeometry() {
  const glb = fs.readFileSync(path.join(root, "assets/models/meridian-anatomy-v1.glb"));
  let document;
  let binary;
  for (let offset = 12; offset < glb.length;) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString("utf8"));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  const mesh = document.meshes.find((value) => value.name === "Skin_Body");
  const accessor = document.accessors[mesh.primitives[0].attributes.POSITION];
  assert.equal(accessor.componentType, 5126, "Skin_Body positions must remain float32");
  assert.equal(accessor.type, "VEC3", "Skin_Body positions must remain three-dimensional");
  const view = document.bufferViews[accessor.bufferView];
  const start = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const stride = view.byteStride || 12;
  const vertices = Array.from({ length: accessor.count }, (_, index) => {
    const offset = start + index * stride;
    return [binary.readFloatLE(offset), binary.readFloatLE(offset + 4), binary.readFloatLE(offset + 8)];
  });
  const indexAccessor = document.accessors[mesh.primitives[0].indices];
  const indexView = document.bufferViews[indexAccessor.bufferView];
  const indexStart = (indexView.byteOffset || 0) + (indexAccessor.byteOffset || 0);
  const bytes = { 5121: 1, 5123: 2, 5125: 4 }[indexAccessor.componentType];
  assert.ok(bytes, "Skin_Body triangle indices must use an unsigned integer accessor");
  const indexStride = indexView.byteStride || bytes;
  const readIndex = bytes === 1 ? "readUInt8" : bytes === 2 ? "readUInt16LE" : "readUInt32LE";
  const indices = Array.from({ length: indexAccessor.count }, (_, index) => binary[readIndex](indexStart + index * indexStride));
  return { vertices, indices };
}
const { vertices: skin, indices: skinIndices } = skinGeometry();

// The mesh is sparse around the two flank samples. Intersect its actual
// triangles at +/-20 mm instead of requiring a vertex inside an arbitrary
// narrow coordinate band. The largest Z intersection is the anterior skin.
function anteriorSkinDepth(x, y) {
  let anteriorZ = Number.NEGATIVE_INFINITY;
  for (let offset = 0; offset < skinIndices.length; offset += 3) {
    const a = skin[skinIndices[offset]];
    const b = skin[skinIndices[offset + 1]];
    const c = skin[skinIndices[offset + 2]];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const acx = c[0] - a[0];
    const acy = c[1] - a[1];
    const determinant = abx * acy - aby * acx;
    if (Math.abs(determinant) < 1e-12) continue;
    const second = ((x - a[0]) * acy - (y - a[1]) * acx) / determinant;
    const third = (abx * (y - a[1]) - aby * (x - a[0])) / determinant;
    const first = 1 - second - third;
    if (Math.min(first, second, third) < -1e-8) continue;
    anteriorZ = Math.max(anteriorZ, first * a[2] + second * b[2] + third * c[2]);
  }
  assert.ok(Number.isFinite(anteriorZ), `Missing anterior skin intersection at x=${x}, y=${y}`);
  return anteriorZ;
}
const navelCandidates = skin.filter(([x, y, z]) => Math.abs(x) < 0.002 && y >= 1.070 && y <= 1.085 && z > 0.110);
assert.ok(navelCandidates.length > 0, "The model's anterior umbilical depression is missing");
const navelDimple = navelCandidates.reduce((deepest, vertex) => vertex[2] < deepest[2] ? vertex : deepest);
assert.ok(Math.abs(y("CV8") - navelDimple[1]) <= 0.003, `CV8 must fit the actual skin navel dimple within 3 mm (mesh y=${navelDimple[1]})`);
const averageFlankZ = (anteriorSkinDepth(-0.020, navelDimple[1]) + anteriorSkinDepth(0.020, navelDimple[1])) / 2;
assert.ok(averageFlankZ - navelDimple[2] > 0.006, "The selected CV8 mesh landmark must be a local depression, not a smooth abdominal point");

// The source's fractions are intentionally unequal by point number: CV6 is
// 1.5 cun below the umbilicus, between CV5 (2) and CV7 (1).
const lowerStep = (y("CV8") - y("CV2")) / 5;
for (const [id, below] of [["CV3", 4], ["CV4", 3], ["CV5", 2], ["CV6", 1.5], ["CV7", 1]]) {
  close(y(id), y("CV8") - below * lowerStep, `${id} lower-abdominal proportional level`);
}
const upperStep = (y("CV15") - y("CV8")) / 7;
for (let cun = 1; cun <= 6; cun += 1) {
  close(y(`CV${8 + cun}`), y("CV8") + cun * upperStep, `CV${8 + cun} upper-abdominal proportional level`);
}

const abdominalPairs = {
  CV2: ["KI11", "ST30", "SP12"], CV3: ["KI12", "ST29"], CV4: ["KI13", "ST28", "GB27"],
  CV5: ["KI14", "ST27"], CV7: ["KI15", "ST26"], CV8: ["KI16", "ST25", "SP15", "GB26"],
  CV9: ["ST24"], CV10: ["KI17", "ST23"], CV11: ["KI18", "ST22", "SP16"],
  CV12: ["KI19", "ST21"], CV13: ["KI20", "ST20"], CV14: ["KI21", "ST19", "LR14"],
};
const intercostalRows = {
  CV16: ["KI22", "ST18", "SP17"], CV17: ["KI23", "ST17", "SP18", "PC1"],
  CV18: ["KI24", "ST16", "SP19"], CV19: ["KI25", "ST15", "SP20"],
  CV20: ["KI26", "ST14"], CV21: ["KI27", "ST13"],
};
for (const [reference, peers] of Object.entries({ ...abdominalPairs, ...intercostalRows })) {
  for (const peer of peers) {
    for (const side of ["left", "right"]) {
      close(position(peer, side)[1], y(reference), `${peer}:${side} horizontal level with ${reference}`);
    }
  }
}

// Lateral lines must stay distinct: 0.5 cun (KI), 2 cun (ST), 4 cun
// (SP) on the abdomen. A nearest-surface snap must not compress them all
// toward the same anterior-lateral skin triangle.
for (const side of ["left", "right"]) {
  const halfCun = Math.abs(position("KI16", side)[0]);
  close(Math.abs(position("ST25", side)[0]), 4 * halfCun, `ST25:${side} two-cun lateral line`);
  close(Math.abs(position("SP15", side)[0]), 8 * halfCun, `SP15:${side} four-cun lateral line`);
  for (const [start, end, prefix] of [[11, 21, "KI"], [19, 30, "ST"], [12, 16, "SP"], [13, 18, "ST"], [22, 27, "KI"], [17, 20, "SP"]]) {
    const expectedX = position(`${prefix}${start}`, side)[0];
    for (let number = start + 1; number <= end; number += 1) {
      close(position(`${prefix}${number}`, side)[0], expectedX, `${prefix}${number}:${side} vertical reference line`);
    }
  }
}
close(y("SP13"), y("SP12") + 0.7 * lowerStep, "SP13 0.7 cun superior to SP12");
close(y("SP14"), y("SP13") + 3 * lowerStep, "SP14 three cun superior to SP13");
close(y("GB28"), y("GB27") - 0.5 * lowerStep, "GB28 half a cun inferior to GB27");
assert.ok(y("KI12") < y("KI13"), "KI12 and KI13 must retain their distinct inferior/superior levels");

// Skull-base points share the source-defined horizontal references and stay
// around the mastoid/upper neck. Correcting GV16 must not leave it collapsed
// onto GV17, or leave GB12 at a lower-neck location inherited from old data.
for (const side of ["left", "right"]) {
  for (const id of ["GB12", "GB20"]) {
    close(position(id, side)[1], y("GV16"), `${id}:${side} suboccipital horizontal level`);
  }
  close(position("BL10", side)[1], y("GV15"), `BL10:${side} GV15 horizontal level`);
  for (const id of ["BL9", "GB19"]) {
    close(position(id, side)[1], y("GV17"), `${id}:${side} GV17 occipital horizontal level`);
  }
  const mastoid = position("GB12", side);
  assert.ok(mastoid[1] >= 1.60 && mastoid[1] < position("GB11", side)[1], `GB12:${side} must remain at the inferior mastoid, below GB11`);
  assert.ok(Math.abs(position("GB20", side)[0]) < Math.abs(mastoid[0]), `GB20:${side} must lie medial to GB12`);
  assert.ok(Math.hypot(...mastoid.map((value, axis) => value - position("GB20", side)[axis])) > 0.015, `GB12:${side} and GB20:${side} must retain distinct recesses`);
}
for (const [inferior, superior] of [["GV15", "GV16"], ["GV16", "GV17"], ["GV17", "GV18"], ["GV18", "GV19"], ["GV19", "GV20"]]) {
  assert.ok(y(superior) > y(inferior), `${superior} must remain superior to ${inferior}`);
  assert.ok(Math.hypot(...position(superior).map((value, axis) => value - position(inferior)[axis])) > 0.010, `${inferior}/${superior} must retain distinct posterior landmarks`);
}

let calibratedInstances = 0;
for (const point of Object.values(dataset.points)) {
  for (const item of point.instances) {
    if (!item.rawAnchor.calibrationBasis) continue;
    calibratedInstances += 1;
    assert.equal(item.anchor.surfaceAttachment.selection, "depth-constrained-triangle", `${item.instanceId} lost its reference-level surface projection`);
    close(item.anchor.position[0], item.rawAnchor.position[0], `${item.instanceId} preserved lateral offset`);
    close(item.anchor.position[1], item.rawAnchor.position[1], `${item.instanceId} preserved horizontal level`);
  }
}
for (let number = 2; number <= 21; number += 1) {
  close(position(`CV${number}`)[0], 0, `CV${number} anterior midline`);
}
assert.ok(calibratedInstances > 0, "The dataset has no anatomical-reference calibrations; regenerate it first.");
console.log(`Coordinate reference checks passed: ${checks} relative-geometry assertions; ${calibratedInstances} calibrated surface attachments.`);
