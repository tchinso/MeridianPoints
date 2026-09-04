/**
 * Generate the first complete MeridianPoints 3D-anchor dataset.
 *
 * This generator intentionally produces an *estimated* educational surface
 * map. It is a data foundation for fitting markers to the project-owned body
 * mesh, not an anatomical atlas and not a source for clinical localisation.
 * Every generated anchor and relationship therefore carries an explicit
 * review status. A qualified reviewer must replace/approve it before an app
 * presents it as a localisation aid.
 *
 * Run from the repository root:
 *   node scripts/build-acupoint-3d-prototype.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "assets", "json", "meridians.json");
const OUTPUT_PATH = path.join(ROOT, "assets", "json", "acupoint-3d.json");
const MODEL_PATH = path.join(ROOT, "assets", "models", "meridian-anatomy-v1.glb");
const SURFACE_MESH_NAME = "Skin_Body";

const ROUND_DIGITS = 6;
const BILATERAL_CODES = new Set(["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR"]);
const MIDLINE_CODES = new Set(["CV", "GV"]);
// The BodyParts3D reference is an adult arms-down mesh. These fit factors
// convert the original neutral-route template space into that mesh's narrower
// torso/limb envelope before the final triangle projection. They are an
// asset-fit transform, not a clinical location adjustment.
const MODEL_ROUTE_POSITION_SCALE = [0.48, 1, 0.70];

const round = (value) => Number(value.toFixed(ROUND_DIGITS));
const vectorLength = (vector) => Math.hypot(...vector);
const normalise = (vector) => {
  const length = vectorLength(vector);
  if (!Number.isFinite(length) || length === 0) throw new Error(`Invalid normal: ${vector}`);
  return vector.map((value) => round(value / length));
};
const lerp = (left, right, fraction) => left + (right - left) * fraction;
const lerpVector = (left, right, fraction) => left.map((value, index) => lerp(value, right[index], fraction));
const distance = (left, right) => Math.hypot(...left.map((value, index) => value - right[index]));

const ACCESSOR_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function readGlb(filePath) {
  const glb = fs.readFileSync(filePath);
  if (glb.subarray(0, 4).toString("ascii") !== "glTF") throw new Error(`${filePath} is not a GLB.`);
  if (glb.readUInt32LE(4) !== 2) throw new Error(`${filePath} is not glTF 2.0.`);

  let offset = 12;
  let document = null;
  let binary = null;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString("utf8"));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (!document || !binary) throw new Error(`${filePath} is missing JSON or binary GLB data.`);
  return { document, binary };
}

function readAccessorValues(document, binary, accessorIndex) {
  const accessor = document.accessors?.[accessorIndex];
  if (!accessor || accessor.sparse) throw new Error(`Unsupported GLB accessor ${accessorIndex}.`);
  const view = document.bufferViews?.[accessor.bufferView];
  const components = ACCESSOR_COMPONENTS[accessor.type];
  const componentBytes = COMPONENT_BYTES[accessor.componentType];
  if (!view || !components || !componentBytes || view.buffer !== 0) {
    throw new Error(`Unsupported GLB accessor layout ${accessorIndex}.`);
  }
  const stride = view.byteStride || components * componentBytes;
  const firstOffset = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const valueCount = accessor.count * components;
  const values = new Float64Array(valueCount);
  const read = (byteOffset) => {
    if (accessor.componentType === 5126) return binary.readFloatLE(byteOffset);
    if (accessor.componentType === 5125) return binary.readUInt32LE(byteOffset);
    if (accessor.componentType === 5123) return binary.readUInt16LE(byteOffset);
    if (accessor.componentType === 5121) return binary.readUInt8(byteOffset);
    if (accessor.componentType === 5122) return binary.readInt16LE(byteOffset);
    return binary.readInt8(byteOffset);
  };
  for (let index = 0; index < accessor.count; index += 1) {
    const offset = firstOffset + index * stride;
    for (let component = 0; component < components; component += 1) {
      values[index * components + component] = read(offset + component * componentBytes);
    }
  }
  return { values, count: accessor.count, components };
}

function loadFinalSurface() {
  const { document, binary } = readGlb(MODEL_PATH);
  const meshIndex = document.meshes?.findIndex((mesh) => mesh.name === SURFACE_MESH_NAME);
  const primitive = document.meshes?.[meshIndex]?.primitives?.[0];
  if (!primitive) throw new Error(`Surface mesh ${SURFACE_MESH_NAME} is missing from ${MODEL_PATH}.`);
  const position = readAccessorValues(document, binary, primitive.attributes?.POSITION);
  const normal = primitive.attributes?.NORMAL === undefined
    ? null
    : readAccessorValues(document, binary, primitive.attributes.NORMAL);
  const index = primitive.indices === undefined ? null : readAccessorValues(document, binary, primitive.indices);
  if (position.components !== 3 || normal?.components !== 3 || (index && index.components !== 1)) {
    throw new Error(`${SURFACE_MESH_NAME} has unsupported position, normal, or index data.`);
  }
  const indices = index
    ? Uint32Array.from(index.values)
    : Uint32Array.from({ length: position.count }, (_, value) => value);
  if (indices.length % 3) throw new Error(`${SURFACE_MESH_NAME} index count is not triangular.`);
  return {
    meshName: SURFACE_MESH_NAME,
    positions: position.values,
    normals: normal?.values || null,
    indices,
    triangleCount: indices.length / 3,
  };
}

function setClosestTrianglePoint(out, x, y, z, first, second, third) {
  out.x = x;
  out.y = y;
  out.z = z;
  out.first = first;
  out.second = second;
  out.third = third;
}

// Ericson's closest-point-on-triangle test, written allocation-free because it
// runs for every estimated anchor against the final skin's triangle set.
function closestPointOnTriangle(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const acx = cx - ax;
  const acy = cy - ay;
  const acz = cz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return setClosestTrianglePoint(out, ax, ay, az, 1, 0, 0);

  const bpx = px - bx;
  const bpy = py - by;
  const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return setClosestTrianglePoint(out, bx, by, bz, 0, 1, 0);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const second = d1 / (d1 - d3);
    return setClosestTrianglePoint(out, ax + second * abx, ay + second * aby, az + second * abz, 1 - second, second, 0);
  }

  const cpx = px - cx;
  const cpy = py - cy;
  const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return setClosestTrianglePoint(out, cx, cy, cz, 0, 0, 1);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const third = d2 / (d2 - d6);
    return setClosestTrianglePoint(out, ax + third * acx, ay + third * acy, az + third * acz, 1 - third, 0, third);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const third = (d4 - d3) / (d4 - d3 + d5 - d6);
    return setClosestTrianglePoint(out, bx + third * (cx - bx), by + third * (cy - by), bz + third * (cz - bz), 0, 1 - third, third);
  }

  const denominator = 1 / (va + vb + vc);
  const second = vb * denominator;
  const third = vc * denominator;
  return setClosestTrianglePoint(
    out,
    ax + abx * second + acx * third,
    ay + aby * second + acy * third,
    az + abz * second + acz * third,
    1 - second - third,
    second,
    third,
  );
}

function closestSurfaceProjection(point, surface) {
  const [px, py, pz] = point;
  const { positions, indices } = surface;
  const scratch = {};
  let bestDistanceSquared = Number.POSITIVE_INFINITY;
  let bestTriangle = -1;
  let bestX = 0;
  let bestY = 0;
  let bestZ = 0;
  let bestFirst = 0;
  let bestSecond = 0;
  let bestThird = 0;

  for (let offset = 0; offset < indices.length; offset += 3) {
    const firstIndex = indices[offset] * 3;
    const secondIndex = indices[offset + 1] * 3;
    const thirdIndex = indices[offset + 2] * 3;
    closestPointOnTriangle(
      px,
      py,
      pz,
      positions[firstIndex],
      positions[firstIndex + 1],
      positions[firstIndex + 2],
      positions[secondIndex],
      positions[secondIndex + 1],
      positions[secondIndex + 2],
      positions[thirdIndex],
      positions[thirdIndex + 1],
      positions[thirdIndex + 2],
      scratch,
    );
    const dx = px - scratch.x;
    const dy = py - scratch.y;
    const dz = pz - scratch.z;
    const candidateDistanceSquared = dx * dx + dy * dy + dz * dz;
    if (candidateDistanceSquared < bestDistanceSquared) {
      bestDistanceSquared = candidateDistanceSquared;
      bestTriangle = offset / 3;
      bestX = scratch.x;
      bestY = scratch.y;
      bestZ = scratch.z;
      bestFirst = scratch.first;
      bestSecond = scratch.second;
      bestThird = scratch.third;
    }
  }
  if (bestTriangle < 0) throw new Error(`Unable to project anchor ${point}.`);

  const firstIndex = indices[bestTriangle * 3];
  const secondIndex = indices[bestTriangle * 3 + 1];
  const thirdIndex = indices[bestTriangle * 3 + 2];
  let nx;
  let ny;
  let nz;
  if (surface.normals) {
    nx = surface.normals[firstIndex * 3] * bestFirst + surface.normals[secondIndex * 3] * bestSecond + surface.normals[thirdIndex * 3] * bestThird;
    ny = surface.normals[firstIndex * 3 + 1] * bestFirst + surface.normals[secondIndex * 3 + 1] * bestSecond + surface.normals[thirdIndex * 3 + 1] * bestThird;
    nz = surface.normals[firstIndex * 3 + 2] * bestFirst + surface.normals[secondIndex * 3 + 2] * bestSecond + surface.normals[thirdIndex * 3 + 2] * bestThird;
  } else {
    const ax = positions[firstIndex];
    const ay = positions[firstIndex + 1];
    const az = positions[firstIndex + 2];
    nx = (positions[secondIndex + 1] - ay) * (positions[thirdIndex + 2] - az) - (positions[secondIndex + 2] - az) * (positions[thirdIndex + 1] - ay);
    ny = (positions[secondIndex + 2] - az) * (positions[thirdIndex] - ax) - (positions[secondIndex] - ax) * (positions[thirdIndex + 2] - az);
    nz = (positions[secondIndex] - ax) * (positions[thirdIndex + 1] - ay) - (positions[secondIndex + 1] - ay) * (positions[thirdIndex] - ax);
  }
  return {
    position: [round(bestX), round(bestY), round(bestZ)],
    normal: normalise([nx, ny, nz]),
    triangle: bestTriangle,
    barycentric: [round(bestFirst), round(bestSecond), round(bestThird)],
    distance: round(Math.sqrt(bestDistanceSquared)),
  };
}

/**
 * A control node belongs to the asset's neutral anatomical reference pose:
 *   x negative = asset's anatomical-left convention
 *   y positive = superior
 *   z positive = anterior
 *
 * All bilateral templates are authored on the left and mirrored at build
 * time. That makes the eventual reviewer work happen once per anatomical
 * route while still producing concrete left/right marker instances.
 */
function node(position, normal, surface, landmark) {
  return {
    position,
    normal: normalise(normal),
    surface,
    landmark,
  };
}

const n = node;

// The product brief supplied this one comparison layout. These are still
// estimated mesh-space positions, not a clinical calibration. Keeping the
// values explicit prevents the generated interpolation from changing a
// curated learning example when the wider route templates are refined.
const EXAMPLE_COMPARISON_OVERRIDES = {
  ST18: {
    left: n([-0.25, 1.325, 0.274], [-0.42, 0.02, 0.91], "anterior-lateral-chest", "fifth intercostal comparison field"),
    right: n([0.25, 1.325, 0.274], [0.42, 0.02, 0.91], "anterior-lateral-chest", "fifth intercostal comparison field"),
  },
  SP17: {
    left: n([-0.275, 1.325, 0.153], [-0.68, 0.02, 0.74], "lateral-chest", "fifth intercostal comparison field"),
    right: n([0.275, 1.325, 0.153], [0.68, 0.02, 0.74], "lateral-chest", "fifth intercostal comparison field"),
  },
};

function range(start, end, routeId, keys) {
  return { start, end, routeId, keys };
}

/**
 * The surface routes below are deliberately coarse, continuous pathways over
 * the current neutral body mesh. They are not claims about precise cun-based
 * locations. `keys` identify how each numbered point is distributed along the
 * explicit route; values between keys are interpolated by point number.
 */
const ROUTE_TEMPLATES = {
  LU_main: {
    code: "LU",
    sideMode: "bilateral",
    label: "anterior chest to radial thumb",
    nodes: [
      n([-0.20, 1.345, 0.238], [-0.52, 0.04, 0.86], "anterior-chest", "upper lateral chest"),
      n([-0.27, 1.365, 0.165], [-0.72, 0.04, 0.69], "axillary-fold", "axillary margin"),
      n([-0.38, 1.320, 0.045], [0.85, 0, 0.42], "medial-upper-arm", "medial biceps contour"),
      n([-0.45, 1.290, 0.045], [0.82, 0, 0.57], "medial-upper-arm", "medial humeral contour"),
      n([-0.50, 1.250, 0.040], [0.76, 0, 0.65], "medial-elbow", "antecubital region"),
      n([-0.57, 1.200, 0.060], [0.72, 0, 0.69], "anterior-medial-forearm", "flexor surface"),
      n([-0.665, 1.120, 0.110], [0.80, 0, 0.60], "radial-wrist", "radial wrist contour"),
      n([-0.720, 1.070, 0.160], [0.22, 0, 0.98], "thenar-palm", "thenar eminence"),
      n([-0.750, 1.030, 0.200], [-0.12, 0, 0.99], "thumb", "thumb radial margin"),
    ],
  },
  LI_main: {
    code: "LI",
    sideMode: "bilateral",
    label: "index finger to face",
    nodes: [
      n([-0.750, 1.020, 0.200], [0, 0, 1], "index-finger", "radial index fingertip"),
      n([-0.735, 1.050, 0.165], [0, 0, 1], "dorsal-hand", "index ray"),
      n([-0.720, 1.080, 0.135], [-0.30, 0, 0.95], "dorsal-hand", "first dorsal interosseous region"),
      n([-0.665, 1.120, 0.090], [-0.52, 0, 0.85], "radial-wrist", "radial wrist"),
      n([-0.580, 1.190, -0.010], [-0.45, 0, -0.89], "dorsolateral-forearm", "radial forearm"),
      n([-0.505, 1.245, -0.040], [-0.50, 0, -0.86], "lateral-elbow", "lateral epicondyle region"),
      n([-0.430, 1.305, -0.005], [-0.55, 0, -0.83], "lateral-upper-arm", "lateral humeral contour"),
      n([-0.34, 1.360, 0.030], [-0.60, 0.08, 0.80], "shoulder", "deltoid/acromial region"),
      n([-0.25, 1.420, 0.100], [-0.20, 0, 0.98], "supraclavicular", "lateral neck base"),
      n([-0.12, 1.540, 0.120], [-0.30, 0, 0.95], "lateral-neck", "sternocleidomastoid region"),
      n([-0.105, 1.640, 0.180], [-0.34, 0, 0.94], "cheek", "nasolabial/cheek surface"),
      n([-0.025, 1.700, 0.208], [-0.08, 0, 1], "nose", "lateral nasal margin"),
    ],
  },
  ST_main: {
    code: "ST",
    sideMode: "bilateral",
    label: "infraorbital face to second toe",
    nodes: [
      n([-0.055, 1.700, 0.158], [-0.22, 0.06, 0.97], "infraorbital-face", "inferior orbital margin"),
      n([-0.11, 1.650, 0.175], [-0.42, 0, 0.91], "cheek", "malar contour"),
      n([-0.15, 1.570, 0.100], [-0.72, 0, 0.69], "jaw", "mandibular angle"),
      n([-0.14, 1.450, 0.120], [-0.42, 0, 0.91], "anterior-lateral-neck", "sternocleidomastoid region"),
      n([-0.24, 1.425, 0.150], [-0.38, 0, 0.93], "supraclavicular", "clavicular fossa"),
      n([-0.25, 1.340, 0.245], [-0.32, 0.04, 0.95], "anterior-lateral-chest", "intercostal chest wall"),
      n([-0.25, 1.200, 0.215], [-0.37, 0, 0.93], "anterior-lateral-chest", "costal margin"),
      n([-0.24, 1.100, 0.210], [-0.42, 0, 0.91], "anterolateral-abdomen", "rectus/oblique transition"),
      n([-0.24, 0.920, 0.190], [-0.48, 0, 0.88], "anterolateral-abdomen", "lower abdominal wall"),
      n([-0.22, 0.790, 0.115], [-0.45, 0, 0.89], "inguinal", "inguinal fold"),
      n([-0.19, 0.660, 0.105], [-0.30, 0, 0.95], "anterior-thigh", "rectus femoris contour"),
      n([-0.18, 0.430, 0.108], [-0.30, 0, 0.95], "anterior-knee", "patellar margin"),
      n([-0.23, 0.390, 0.110], [-0.58, 0, 0.81], "lateral-knee", "lateral patellar margin"),
      n([-0.22, 0.280, 0.108], [-0.54, 0, 0.84], "anterolateral-leg", "tibialis anterior region"),
      n([-0.21, 0.100, 0.125], [-0.45, 0, 0.89], "anterior-ankle", "anterior ankle"),
      n([-0.20, 0.060, 0.200], [-0.12, 0, 0.99], "dorsal-foot", "metatarsal surface"),
      n([-0.19, 0.045, 0.300], [0, 0, 1], "second-toe", "second toe tip"),
    ],
  },
  SP_main: {
    code: "SP",
    sideMode: "bilateral",
    label: "medial great toe to lateral chest",
    nodes: [
      n([-0.16, 0.045, 0.300], [0.20, 0, 0.98], "great-toe", "medial great toe"),
      n([-0.14, 0.055, 0.200], [0.50, 0, 0.87], "medial-foot", "medial arch"),
      n([-0.14, 0.090, 0.040], [0.76, 0, 0.65], "medial-ankle", "medial malleolus region"),
      n([-0.13, 0.200, 0.015], [0.90, 0, 0.43], "medial-leg", "medial tibial contour"),
      n([-0.12, 0.390, 0.020], [0.92, 0, 0.39], "medial-knee", "medial tibial condyle region"),
      n([-0.105, 0.570, 0.040], [0.85, 0, 0.53], "medial-thigh", "adductor contour"),
      n([-0.09, 0.750, 0.100], [0.52, 0, 0.85], "medial-thigh", "proximal medial thigh"),
      n([-0.10, 0.880, 0.190], [-0.35, 0, 0.94], "lower-abdomen", "lower abdominal wall"),
      n([-0.11, 1.050, 0.205], [-0.42, 0, 0.91], "anterior-abdomen", "rectus border"),
      n([-0.16, 1.200, 0.220], [-0.42, 0, 0.91], "anterior-lateral-chest", "lower intercostal wall"),
      n([-0.205, 1.310, 0.245], [-0.43, 0, 0.90], "lateral-chest", "upper intercostal wall"),
      n([-0.29, 1.350, 0.130], [-0.76, 0.04, 0.65], "axillary-chest", "lateral chest/axillary line"),
    ],
  },
  HT_main: {
    code: "HT",
    sideMode: "bilateral",
    label: "axilla to little finger",
    nodes: [
      n([-0.30, 1.360, 0.050], [0.18, 0, 0.98], "axillary-fold", "axillary center"),
      n([-0.40, 1.320, 0.045], [0.82, 0, 0.57], "medial-upper-arm", "medial biceps contour"),
      n([-0.50, 1.250, 0.040], [0.78, 0, 0.63], "medial-elbow", "medial elbow crease"),
      n([-0.580, 1.200, 0.060], [0.72, 0, 0.69], "anterior-medial-forearm", "flexor surface"),
      n([-0.660, 1.125, 0.110], [0.72, 0, 0.69], "ulnar-wrist", "ulnar wrist contour"),
      n([-0.720, 1.070, 0.160], [0.06, 0, 1], "ulnar-palm", "hypothenar/palm"),
      n([-0.750, 1.040, 0.185], [-0.10, 0, 1], "little-finger", "little finger ray"),
      n([-0.765, 1.015, 0.200], [0, 0, 1], "little-finger", "little finger tip"),
    ],
  },
  SI_main: {
    code: "SI",
    sideMode: "bilateral",
    label: "little finger to ear",
    nodes: [
      n([-0.765, 1.015, 0.200], [0, 0, 1], "little-finger", "little finger tip"),
      n([-0.750, 1.040, 0.170], [0, 0, 1], "dorsal-hand", "ulnar hand"),
      n([-0.720, 1.070, 0.120], [-0.40, 0, 0.92], "dorsal-hand", "ulnar carpus"),
      n([-0.665, 1.120, 0.055], [-0.52, 0, -0.85], "dorsoulnar-wrist", "ulnar wrist"),
      n([-0.580, 1.190, -0.035], [-0.45, 0, -0.89], "posterolateral-forearm", "ulnar extensor surface"),
      n([-0.505, 1.245, -0.055], [-0.25, 0, -0.97], "posterior-elbow", "olecranon region"),
      n([-0.425, 1.305, -0.055], [-0.44, 0, -0.90], "posterior-upper-arm", "triceps contour"),
      n([-0.33, 1.380, -0.015], [-0.62, 0.08, -0.78], "posterior-shoulder", "posterior deltoid"),
      n([-0.24, 1.360, -0.155], [-0.50, 0, -0.86], "scapular", "scapular spine region"),
      n([-0.15, 1.500, -0.060], [-0.55, 0, -0.83], "posterolateral-neck", "lateral neck"),
      n([-0.16, 1.650, -0.010], [-0.98, 0, -0.18], "ear", "auricular region"),
      n([-0.14, 1.710, 0.080], [-0.75, 0, 0.66], "temple", "anterior auricular surface"),
    ],
  },
  BL_head: {
    code: "BL",
    sideMode: "bilateral",
    label: "medial eye to posterior neck",
    nodes: [
      n([-0.045, 1.700, 0.158], [-0.18, 0.08, 0.98], "medial-eye", "medial canthus region"),
      n([-0.05, 1.740, 0.135], [-0.24, 0.54, 0.81], "brow", "medial brow"),
      n([-0.06, 1.770, 0.080], [-0.40, 0.80, 0.45], "frontal-scalp", "frontal hairline"),
      n([-0.065, 1.805, 0.000], [-0.62, 0.78, 0], "parietal-scalp", "parietal scalp"),
      n([-0.065, 1.780, -0.100], [-0.50, 0.62, -0.60], "posterior-scalp", "parietal-occipital transition"),
      n([-0.07, 1.700, -0.170], [-0.45, 0.18, -0.87], "occiput", "occipital scalp"),
      n([-0.07, 1.540, -0.100], [-0.48, 0, -0.88], "posterior-neck", "upper cervical region"),
    ],
  },
  BL_inner: {
    code: "BL",
    sideMode: "bilateral",
    label: "inner paraspinal line to popliteal fossa",
    nodes: [
      n([-0.065, 1.390, -0.200], [-0.28, 0, -0.96], "paraspinal-back", "upper thoracic paraspinal line"),
      n([-0.07, 1.320, -0.220], [-0.30, 0, -0.95], "paraspinal-back", "scapular medial border level"),
      n([-0.07, 1.220, -0.210], [-0.32, 0, -0.95], "paraspinal-back", "mid thoracic paraspinal line"),
      n([-0.07, 1.120, -0.200], [-0.34, 0, -0.94], "paraspinal-back", "lower thoracic paraspinal line"),
      n([-0.07, 1.020, -0.190], [-0.35, 0, -0.94], "paraspinal-back", "upper lumbar paraspinal line"),
      n([-0.07, 0.940, -0.180], [-0.36, 0, -0.93], "paraspinal-back", "lower lumbar paraspinal line"),
      n([-0.07, 0.790, -0.110], [-0.42, 0, -0.91], "sacral", "sacral foraminal region"),
      n([-0.11, 0.750, -0.150], [-0.56, 0, -0.83], "gluteal", "medial gluteal contour"),
      n([-0.15, 0.640, -0.110], [-0.44, 0, -0.90], "posterior-thigh", "hamstring contour"),
      n([-0.17, 0.490, -0.090], [-0.34, 0, -0.94], "posterior-thigh", "distal hamstring contour"),
      n([-0.18, 0.380, -0.100], [-0.18, 0, -0.98], "popliteal", "popliteal fossa"),
    ],
  },
  BL_outer: {
    code: "BL",
    sideMode: "bilateral",
    label: "outer back line to lateral fifth toe",
    nodes: [
      n([-0.18, 1.390, -0.200], [-0.62, 0, -0.79], "paraspinal-back", "upper thoracic outer line"),
      n([-0.20, 1.250, -0.230], [-0.62, 0, -0.79], "scapular-back", "scapular lateral field"),
      n([-0.20, 1.100, -0.210], [-0.62, 0, -0.79], "posterolateral-back", "thoracolumbar field"),
      n([-0.20, 0.950, -0.200], [-0.60, 0, -0.80], "posterolateral-back", "lumbar field"),
      n([-0.21, 0.820, -0.140], [-0.56, 0, -0.83], "gluteal", "upper gluteal contour"),
      n([-0.25, 0.760, -0.100], [-0.68, 0, -0.73], "gluteal", "lateral gluteal contour"),
      n([-0.22, 0.470, -0.100], [-0.42, 0, -0.91], "posterior-thigh", "posterolateral thigh"),
      n([-0.22, 0.310, -0.090], [-0.42, 0, -0.91], "posterior-leg", "gastrocnemius contour"),
      n([-0.215, 0.140, -0.055], [-0.36, 0, -0.93], "posterolateral-leg", "achilles/lateral calf region"),
      n([-0.21, 0.090, 0.000], [-0.42, 0, -0.91], "lateral-ankle", "lateral malleolus"),
      n([-0.22, 0.060, 0.100], [-0.45, 0, 0.89], "lateral-foot", "lateral foot border"),
      n([-0.22, 0.045, 0.200], [-0.22, 0, 0.98], "lateral-foot", "fifth metatarsal region"),
      n([-0.24, 0.040, 0.300], [-0.16, 0, 0.99], "fifth-toe", "lateral fifth toe"),
    ],
  },
  KI_main: {
    code: "KI",
    sideMode: "bilateral",
    label: "plantar foot to clavicle",
    nodes: [
      n([-0.19, 0.008, 0.140], [0, -1, 0], "plantar-foot", "plantar arch"),
      n([-0.17, 0.040, 0.210], [0.32, -0.20, 0.93], "medial-plantar-foot", "medial plantar arch"),
      n([-0.15, 0.090, 0.020], [0.80, 0, 0.60], "medial-ankle", "posterior medial malleolus"),
      n([-0.135, 0.220, 0.015], [0.90, 0, 0.44], "medial-leg", "medial tibial border"),
      n([-0.13, 0.340, 0.020], [0.92, 0, 0.39], "medial-leg", "medial calf"),
      n([-0.13, 0.400, 0.020], [0.93, 0, 0.36], "medial-knee", "medial knee"),
      n([-0.12, 0.620, 0.035], [0.86, 0, 0.51], "medial-thigh", "adductor field"),
      n([-0.11, 0.750, 0.120], [0.50, 0, 0.87], "inguinal", "pubic/inguinal region"),
      n([-0.10, 0.820, 0.180], [-0.38, 0, 0.93], "lower-abdomen", "lower rectus field"),
      n([-0.10, 1.010, 0.210], [-0.40, 0, 0.92], "anterior-abdomen", "rectus field"),
      n([-0.10, 1.130, 0.220], [-0.40, 0, 0.92], "upper-abdomen", "upper rectus field"),
      n([-0.12, 1.200, 0.220], [-0.42, 0, 0.91], "lower-chest", "costal margin"),
      n([-0.14, 1.340, 0.230], [-0.45, 0, 0.89], "anterior-chest", "intercostal chest wall"),
      n([-0.20, 1.430, 0.150], [-0.43, 0, 0.90], "infraclavicular", "clavicular field"),
    ],
  },
  PC_main: {
    code: "PC",
    sideMode: "bilateral",
    label: "lateral chest to middle finger",
    nodes: [
      n([-0.25, 1.300, 0.225], [-0.38, 0, 0.93], "anterior-lateral-chest", "fourth intercostal field"),
      n([-0.30, 1.350, 0.090], [-0.62, 0, 0.79], "axillary-fold", "axillary fold"),
      n([-0.40, 1.320, 0.050], [0.82, 0, 0.57], "medial-upper-arm", "medial biceps field"),
      n([-0.50, 1.250, 0.045], [0.78, 0, 0.63], "medial-elbow", "antecubital field"),
      n([-0.580, 1.200, 0.065], [0.72, 0, 0.69], "anterior-forearm", "palmar forearm"),
      n([-0.660, 1.125, 0.115], [0.52, 0, 0.85], "palmar-wrist", "palmar wrist"),
      n([-0.720, 1.070, 0.165], [0, 0, 1], "palm", "central palm"),
      n([-0.755, 1.015, 0.200], [0, 0, 1], "middle-finger", "middle fingertip"),
    ],
  },
  TE_main: {
    code: "TE",
    sideMode: "bilateral",
    label: "ring finger to temple",
    nodes: [
      n([-0.755, 1.015, 0.200], [0, 0, 1], "ring-finger", "ring finger tip"),
      n([-0.745, 1.040, 0.170], [0, 0, 1], "dorsal-hand", "ring finger ray"),
      n([-0.720, 1.070, 0.120], [-0.42, 0, 0.91], "dorsal-hand", "dorsal carpus"),
      n([-0.665, 1.120, 0.050], [-0.48, 0, -0.88], "dorsal-wrist", "dorsal wrist"),
      n([-0.580, 1.190, -0.040], [-0.48, 0, -0.88], "posterolateral-forearm", "extensor surface"),
      n([-0.505, 1.245, -0.050], [-0.34, 0, -0.94], "posterior-elbow", "olecranon/lateral elbow"),
      n([-0.425, 1.305, -0.045], [-0.48, 0, -0.88], "posterolateral-upper-arm", "triceps/deltoid field"),
      n([-0.33, 1.390, -0.010], [-0.70, 0.06, -0.71], "posterior-shoulder", "acromial field"),
      n([-0.18, 1.500, -0.050], [-0.56, 0, -0.83], "posterolateral-neck", "lateral neck"),
      n([-0.16, 1.680, -0.020], [-0.98, 0, -0.18], "ear", "auricular field"),
      n([-0.13, 1.750, 0.040], [-0.76, 0.12, 0.64], "temple", "temporal scalp"),
    ],
  },
  GB_main: {
    code: "GB",
    sideMode: "bilateral",
    label: "lateral eye to fourth toe",
    nodes: [
      n([-0.145, 1.700, 0.145], [-0.70, 0.05, 0.71], "lateral-eye", "lateral orbital margin"),
      n([-0.16, 1.740, 0.060], [-0.94, 0.25, 0.23], "temple", "temporal fossa"),
      n([-0.16, 1.760, -0.040], [-0.98, 0.18, -0.06], "temporal-scalp", "superior temporal scalp"),
      n([-0.17, 1.690, -0.090], [-0.94, 0, -0.34], "posterior-auricular", "mastoid region"),
      n([-0.20, 1.540, -0.040], [-0.70, 0, -0.72], "posterolateral-neck", "posterior cervical field"),
      n([-0.33, 1.400, 0.020], [-0.80, 0.06, 0.60], "shoulder", "trapezius/acromial field"),
      n([-0.34, 1.280, 0.060], [-0.85, 0, 0.53], "lateral-chest", "lateral thoracic wall"),
      n([-0.31, 1.050, 0.040], [-0.90, 0, 0.44], "lateral-torso", "oblique field"),
      n([-0.28, 0.800, 0.040], [-0.88, 0, 0.48], "lateral-hip", "iliac crest/hip"),
      n([-0.28, 0.640, 0.030], [-0.94, 0, 0.34], "lateral-thigh", "vastus lateralis field"),
      n([-0.26, 0.390, 0.040], [-0.92, 0, 0.39], "lateral-knee", "fibular head/knee field"),
      n([-0.25, 0.300, 0.020], [-0.95, 0, 0.31], "lateral-leg", "fibular line"),
      n([-0.245, 0.080, 0.020], [-0.90, 0, 0.44], "lateral-ankle", "lateral malleolus"),
      n([-0.23, 0.050, 0.160], [-0.45, 0, 0.89], "dorsal-foot", "fourth metatarsal line"),
      n([-0.22, 0.040, 0.290], [-0.22, 0, 0.98], "fourth-toe", "fourth toe tip"),
    ],
  },
  LR_main: {
    code: "LR",
    sideMode: "bilateral",
    label: "lateral great toe to sixth intercostal field",
    nodes: [
      n([-0.22, 0.040, 0.300], [-0.18, 0, 0.98], "great-toe", "lateral great toe"),
      n([-0.21, 0.050, 0.200], [-0.45, 0, 0.89], "dorsal-foot", "first metatarsal line"),
      n([-0.20, 0.090, 0.020], [-0.75, 0, 0.66], "anterior-ankle", "anterior medial ankle"),
      n([-0.16, 0.240, 0.020], [0.86, 0, 0.51], "medial-leg", "medial tibial field"),
      n([-0.14, 0.400, 0.020], [0.90, 0, 0.44], "medial-knee", "medial knee"),
      n([-0.12, 0.650, 0.030], [0.82, 0, 0.57], "medial-thigh", "adductor field"),
      n([-0.13, 0.780, 0.110], [0.48, 0, 0.88], "inguinal", "inguinal crease"),
      n([-0.16, 0.950, 0.200], [-0.62, 0, 0.78], "lateral-abdomen", "lower oblique field"),
      n([-0.20, 1.130, 0.220], [-0.65, 0, 0.76], "lateral-abdomen", "upper oblique/costal field"),
      n([-0.28, 1.280, 0.170], [-0.80, 0, 0.60], "lateral-chest", "sixth intercostal field"),
    ],
  },
  CV_main: {
    code: "CV",
    sideMode: "midline",
    label: "anterior midline from perineum to lower lip",
    nodes: [
      n([0, 0.750, 0.120], [0, 0, 1], "anterior-perineum", "perineal midline"),
      n([0, 0.800, 0.160], [0, 0, 1], "pubic", "pubic midline"),
      n([0, 0.900, 0.210], [0, 0, 1], "lower-abdomen", "lower abdominal midline"),
      n([0, 1.040, 0.220], [0, 0, 1], "umbilical-abdomen", "umbilical midline"),
      n([0, 1.130, 0.225], [0, 0, 1], "upper-abdomen", "upper abdominal midline"),
      n([0, 1.205, 0.236], [0, 0.03, 1], "xiphoid-lower-chest", "xiphoid region"),
      n([0, 1.325, 0.268], [0, 0.02, 1], "sternal-chest", "lower sternal/intercostal field"),
      n([0, 1.365, 0.249], [0, 0.03, 1], "sternal-chest", "mid sternum/intercostal field"),
      n([0, 1.405, 0.210], [0, 0, 1], "upper-sternum", "upper sternal field"),
      n([0, 1.470, 0.160], [0, 0, 1], "anterior-neck", "suprasternal/neck midline"),
      n([0, 1.520, 0.150], [0, 0, 1], "anterior-neck", "laryngeal midline"),
      n([0, 1.580, 0.145], [0, 0, 1], "chin", "mental midline"),
      n([0, 1.650, 0.190], [0, 0, 1], "lower-lip", "lower lip midline"),
    ],
  },
  GV_main: {
    code: "GV",
    sideMode: "midline",
    label: "posterior midline from perineum over scalp to upper gum",
    nodes: [
      n([0, 0.750, -0.100], [0, 0, -1], "posterior-perineum", "perineal posterior midline"),
      n([0, 0.820, -0.150], [0, 0, -1], "sacral", "sacral midline"),
      n([0, 0.940, -0.190], [0, 0, -1], "lumbar-spine", "lumbar spinous line"),
      n([0, 1.100, -0.205], [0, 0, -1], "thoracic-spine", "thoracic spinous line"),
      n([0, 1.280, -0.210], [0, 0, -1], "upper-thoracic-spine", "upper thoracic spinous line"),
      n([0, 1.390, -0.200], [0, 0, -1], "cervicothoracic", "cervicothoracic midline"),
      n([0, 1.500, -0.060], [0, 0, -1], "posterior-neck", "posterior cervical midline"),
      n([0, 1.620, -0.150], [0, 0.12, -0.99], "occiput", "occipital midline"),
      n([0, 1.800, -0.010], [0, 1, 0], "vertex", "vertex scalp"),
      n([0, 1.790, 0.100], [0, 0.72, 0.70], "frontal-scalp", "frontal midline"),
      n([0, 1.730, 0.160], [0, 0.35, 0.94], "forehead", "forehead midline"),
      n([0, 1.670, 0.205], [0, 0, 1], "upper-gum", "upper gingival midline"),
    ],
  },
};

const MERIDIAN_PLANS = {
  LU: { sideMode: "bilateral", ranges: [range(1, 11, "LU_main", [[1, 0], [2, 0.125], [3, 0.25], [5, 0.375], [6, 0.5], [8, 0.625], [10, 0.75], [11, 1]])] },
  LI: { sideMode: "bilateral", ranges: [range(1, 20, "LI_main", [[1, 0], [4, 0.182], [5, 0.273], [10, 0.455], [15, 0.636], [18, 0.909], [20, 1]])] },
  ST: { sideMode: "bilateral", ranges: [range(1, 45, "ST_main", [[1, 0], [7, 0.125], [9, 0.188], [12, 0.25], [18, 0.313], [25, 0.438], [30, 0.563], [35, 0.75], [41, 0.875], [45, 1]])] },
  SP: { sideMode: "bilateral", ranges: [range(1, 21, "SP_main", [[1, 0], [5, 0.182], [10, 0.364], [15, 0.727], [18, 0.909], [21, 1]])] },
  HT: { sideMode: "bilateral", ranges: [range(1, 9, "HT_main", [[1, 0], [3, 0.286], [4, 0.429], [7, 0.571], [9, 1]])] },
  SI: { sideMode: "bilateral", ranges: [range(1, 19, "SI_main", [[1, 0], [4, 0.273], [8, 0.455], [11, 0.545], [14, 0.727], [17, 0.909], [19, 1]])] },
  BL: {
    sideMode: "bilateral",
    ranges: [
      range(1, 10, "BL_head", [[1, 0], [4, 0.333], [7, 0.833], [10, 1]]),
      range(11, 40, "BL_inner", [[11, 0], [20, 0.32], [30, 0.60], [36, 0.78], [40, 1]]),
      range(41, 67, "BL_outer", [[41, 0], [50, 0.25], [54, 0.417], [58, 0.583], [63, 0.833], [67, 1]]),
    ],
  },
  KI: { sideMode: "bilateral", ranges: [range(1, 27, "KI_main", [[1, 0], [3, 0.154], [10, 0.385], [16, 0.692], [21, 0.846], [27, 1]])] },
  PC: { sideMode: "bilateral", ranges: [range(1, 9, "PC_main", [[1, 0], [3, 0.286], [4, 0.429], [7, 0.714], [9, 1]])] },
  TE: { sideMode: "bilateral", ranges: [range(1, 23, "TE_main", [[1, 0], [4, 0.30], [6, 0.40], [10, 0.50], [14, 0.60], [17, 0.70], [23, 1]])] },
  GB: { sideMode: "bilateral", ranges: [range(1, 44, "GB_main", [[1, 0], [14, 0.214], [21, 0.357], [29, 0.571], [34, 0.714], [40, 0.857], [44, 1]])] },
  LR: { sideMode: "bilateral", ranges: [range(1, 14, "LR_main", [[1, 0], [4, 0.333], [8, 0.667], [11, 0.889], [14, 1]])] },
  CV: { sideMode: "midline", ranges: [range(1, 24, "CV_main", [[1, 0], [8, 0.25], [15, 0.417], [16, 0.50], [17, 0.583], [18, 0.667], [22, 0.833], [24, 1]])] },
  GV: { sideMode: "midline", ranges: [range(1, 28, "GV_main", [[1, 0], [4, 0.091], [14, 0.364], [20, 0.545], [23, 0.636], [26, 0.818], [28, 1]])] },
};

function mirrorNode(leftNode) {
  return {
    ...leftNode,
    position: [round(-leftNode.position[0]), ...leftNode.position.slice(1)],
    normal: [round(-leftNode.normal[0]), ...leftNode.normal.slice(1)],
  };
}

function fitRouteNodeToModel(routeNode) {
  const position = routeNode.position.map((value, index) => round(value * MODEL_ROUTE_POSITION_SCALE[index]));
  const normal = normalise(routeNode.normal.map((value, index) => value / MODEL_ROUTE_POSITION_SCALE[index]));
  return { ...routeNode, position, normal };
}

function routePointsForSide(template, side) {
  const sidedNodes = side === "right" ? template.nodes.map(mirrorNode) : template.nodes;
  return sidedNodes.map(fitRouteNodeToModel);
}

function anchorAt(nodes, fraction) {
  // Route fraction is intentionally based on the authored control-node order,
  // not the physical length of each segment. This keeps dense face, hand and
  // thorax landmark groups from being diluted by a long thigh/leg segment.
  const target = Math.min(1, Math.max(0, fraction)) * (nodes.length - 1);
  const lowerIndex = Math.floor(target);
  const upperIndex = Math.min(nodes.length - 1, lowerIndex + 1);
  const localFraction = target - lowerIndex;
  const lower = nodes[lowerIndex];
  const upper = nodes[upperIndex];
  return {
    position: lerpVector(lower.position, upper.position, localFraction).map(round),
    normal: normalise(lerpVector(lower.normal, upper.normal, localFraction)),
    surface: localFraction < 0.5 ? lower.surface : upper.surface,
    landmark: localFraction < 0.5 ? lower.landmark : upper.landmark,
  };
}

function interpolatePointProgress(keys, pointNumber) {
  if (!Array.isArray(keys) || keys.length < 2) throw new Error(`A route range needs two progress keys.`);
  if (pointNumber < keys[0][0] || pointNumber > keys.at(-1)[0]) {
    throw new Error(`Point ${pointNumber} falls outside its route keys.`);
  }
  for (let index = 1; index < keys.length; index += 1) {
    const [rightNumber, rightProgress] = keys[index];
    const [leftNumber, leftProgress] = keys[index - 1];
    if (pointNumber <= rightNumber) {
      const fraction = (pointNumber - leftNumber) / (rightNumber - leftNumber);
      return round(lerp(leftProgress, rightProgress, fraction));
    }
  }
  return keys.at(-1)[1];
}

function routeAssignment(code, pointNumber) {
  const plan = MERIDIAN_PLANS[code];
  if (!plan) throw new Error(`No surface-route plan for ${code}.`);
  const matchingRange = plan.ranges.find((candidate) => pointNumber >= candidate.start && pointNumber <= candidate.end);
  if (!matchingRange) throw new Error(`No route range for ${code}${pointNumber}.`);
  return {
    plan,
    range: matchingRange,
    routeFraction: interpolatePointProgress(matchingRange.keys, pointNumber),
  };
}

function makeInstance(point, assignment, side) {
  const template = ROUTE_TEMPLATES[assignment.range.routeId];
  const routeNodes = routePointsForSide(template, side);
  const override = EXAMPLE_COMPARISON_OVERRIDES[point.id]?.[side];
  const anchored = override ? fitRouteNodeToModel(override) : anchorAt(routeNodes, assignment.routeFraction);
  const sideSuffix = side === "left" ? "L" : side === "right" ? "R" : "M";
  const rawAnchor = {
    position: anchored.position,
    normal: anchored.normal,
    surface: anchored.surface,
    landmark: anchored.landmark,
    status: "estimated",
    reviewStatus: "needs-anatomical-and-model-fit-review",
    provenance: override ? "user-specified-comparison-layout" : "route-template-interpolation",
  };
  return {
    instanceId: `${point.id}:${sideSuffix}`,
    laterality: side,
    routeId: `${assignment.range.routeId}:${sideSuffix}`,
    routeFraction: assignment.routeFraction,
    rawAnchor,
    anchor: { ...rawAnchor },
    marker: {
      offsetAlongNormal: 0.008,
      radius: 0.018,
      status: "estimated",
    },
  };
}

function projectInstancesToFinalSurface(points, surface) {
  const distances = [];
  for (const point of points.values()) {
    for (const instance of point.instances) {
      const projection = closestSurfaceProjection(instance.rawAnchor.position, surface);
      distances.push(projection.distance);
      instance.anchor = {
        ...instance.rawAnchor,
        position: projection.position,
        normal: projection.normal,
        provenance: "nearest-triangle-projection",
        rawProvenance: instance.rawAnchor.provenance,
        surfaceAttachment: {
          mesh: surface.meshName,
          triangle: projection.triangle,
          barycentric: projection.barycentric,
          projectionDistance: projection.distance,
          normal: "outward-interpolated-skin-normal",
          status: "estimated",
          reviewStatus: "needs-anatomical-and-model-fit-review",
        },
      };
    }
  }
  distances.sort((left, right) => left - right);
  const percentile = (fraction) => distances[Math.min(distances.length - 1, Math.floor((distances.length - 1) * fraction))];
  return {
    mesh: surface.meshName,
    triangleCount: surface.triangleCount,
    instanceCount: distances.length,
    minimumDistance: round(distances[0]),
    medianDistance: round(percentile(0.5)),
    p95Distance: round(percentile(0.95)),
    maximumDistance: round(distances.at(-1)),
  };
}

function makeSurfaceRoutes() {
  const routes = {};
  for (const [templateId, template] of Object.entries(ROUTE_TEMPLATES)) {
    const sides = template.sideMode === "bilateral" ? ["left", "right"] : ["midline"];
    for (const side of sides) {
      const suffix = side === "left" ? "L" : side === "right" ? "R" : "M";
      const routeId = `${templateId}:${suffix}`;
      routes[routeId] = {
        routeId,
        meridianCode: template.code,
        laterality: side,
        label: template.label,
        coordinateStatus: "estimated",
        reviewStatus: "needs-anatomical-and-model-fit-review",
        controlPoints: routePointsForSide(template, side),
      };
    }
  }
  return routes;
}

function assertSourcePoints(source) {
  if (!Array.isArray(source.meridians)) throw new Error("The source data has no meridian list.");
  const points = source.meridians.flatMap((meridian) => meridian.points.map((point) => ({ ...point, meridianName: meridian.name })));
  const duplicateIds = points.map((point) => point.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length) throw new Error(`Duplicate point ids: ${[...new Set(duplicateIds)].join(", ")}`);
  if (source.totalPoints !== points.length) throw new Error(`Expected ${source.totalPoints} source points, found ${points.length}.`);
  return points;
}

function compatibleInstance(point, sourceLaterality) {
  if (point.laterality === "midline") return point.instances[0];
  const wanted = sourceLaterality === "right" ? "right" : "left";
  return point.instances.find((instance) => instance.laterality === wanted);
}

function addNeighbourRelations(pointsById) {
  const points = [...pointsById.values()];
  for (const point of points) {
    const primaryInstance = compatibleInstance(point, "left");
    const candidates = points
      .filter((candidate) => candidate.id !== point.id && candidate.meridian.code !== point.meridian.code)
      .map((candidate) => {
        const candidateInstance = compatibleInstance(candidate, primaryInstance.laterality);
        return {
          pointId: candidate.id,
          instancePolicy: candidate.laterality === "midline" ? "midline" : "same-side",
          surfaceDistance: round(distance(primaryInstance.anchor.position, candidateInstance.anchor.position)),
        };
      })
      .filter((candidate) => candidate.surfaceDistance <= 0.16)
      .sort((left, right) => left.surfaceDistance - right.surfaceDistance || left.pointId.localeCompare(right.pointId))
      .slice(0, 4)
      .map((candidate) => ({
        ...candidate,
        relationship: "computed-surface-proximity",
        status: "estimated",
        reviewStatus: "not-approved-for-comparison-display",
      }));

    const sequentialIds = [
      point.number > 1 ? `${point.meridian.code}${point.number - 1}` : null,
      point.number < point.meridian.pointCount ? `${point.meridian.code}${point.number + 1}` : null,
    ].filter(Boolean);
    const learningComparisonDisplay = [...new Set([
      ...sequentialIds,
      ...candidates.slice(0, 2).map((candidate) => candidate.pointId),
    ])].filter((pointId) => pointId !== point.id).slice(0, 4);

    point.neighbourRelations = {
      sequential: {
        previous: sequentialIds[0] || null,
        next: sequentialIds[1] || null,
        status: "source-order-only",
        reviewStatus: "not-a-clinical-neighbour-claim",
      },
      computedSurfaceProximity: candidates,
      curatedComparisonDisplay: [],
      learningComparisonDisplay,
      displayPolicy: "Render curatedComparisonDisplay when present; otherwise render learningComparisonDisplay as estimated black comparison markers.",
    };
  }
}

function validate(output, sourcePoints) {
  const outputIds = Object.keys(output.points);
  const sourceIds = new Set(sourcePoints.map((point) => point.id));
  if (outputIds.length !== sourceIds.size) throw new Error(`Output has ${outputIds.length} canonical points; expected ${sourceIds.size}.`);
  for (const id of sourceIds) if (!output.points[id]) throw new Error(`Missing output point ${id}.`);

  let bilateralInstances = 0;
  let midlineInstances = 0;
  for (const point of Object.values(output.points)) {
    const expectedInstances = point.laterality === "bilateral" ? 2 : 1;
    if (point.instances.length !== expectedInstances) throw new Error(`${point.id} has incorrect instance count.`);
    if (point.coordinateStatus !== "estimated" || point.reviewStatus !== "needs-anatomical-and-model-fit-review") {
      throw new Error(`${point.id} is missing its explicit estimated/review labels.`);
    }
    for (const instance of point.instances) {
      const coordinates = [...instance.anchor.position, ...instance.anchor.normal];
      if (coordinates.some((value) => !Number.isFinite(value))) throw new Error(`${instance.instanceId} has non-finite coordinates.`);
      if (!output.surfaceRoutes[instance.routeId]) throw new Error(`${instance.instanceId} references a missing route.`);
      if (!instance.rawAnchor || !instance.anchor.surfaceAttachment) throw new Error(`${instance.instanceId} is missing raw or projected surface data.`);
      if (instance.anchor.surfaceAttachment.mesh !== SURFACE_MESH_NAME) throw new Error(`${instance.instanceId} is not attached to ${SURFACE_MESH_NAME}.`);
      if (!Number.isFinite(instance.anchor.surfaceAttachment.projectionDistance)) {
        throw new Error(`${instance.instanceId} has an invalid projection distance.`);
      }
      if (instance.laterality === "midline") midlineInstances += 1;
      else bilateralInstances += 1;
    }
  }
  if (bilateralInstances !== 618 || midlineInstances !== 52) {
    throw new Error(`Unexpected instance coverage: ${bilateralInstances} bilateral, ${midlineInstances} midline.`);
  }
}

function makeViewerDataset(prototype) {
  const points = Object.fromEntries(
    Object.entries(prototype.points).map(([id, entry]) => [
      id,
      id === "CV16"
        ? {
            ...entry,
            focus: {
              distance: 1.0,
              mobileDistance: 1.0,
              fov: 42,
              mobileFov: 42,
            },
          }
        : entry,
    ]),
  );

  return {
    ...prototype,
    version: "0.2.0-viewer-prototype",
    model: {
      url: "assets/models/meridian-anatomy-v1.glb",
      surfaceMesh: "Skin_Body",
      camera: {
        position: [0, 1.2, 2.85],
        target: [0, 0.93, 0],
        fov: 42,
        focusDistance: 1.0,
      },
      markerRadius: 0.018,
      markerOffset: 0.008,
    },
    comparisons: {
      CV16: {
        nearby: ["CV17", "CV15", "ST18", "SP17"],
        status: "curated-display-set",
        reviewStatus: "needs-anatomical-and-model-fit-review",
        note: "User-specified learning comparison layout. Bilateral point entries render both left and right instances, yielding six black markers.",
      },
    },
    comparisonPolicy: {
      default: "Sequential and nearest-surface estimated comparison points are displayed when no curated comparison set exists.",
      renderableSource: "comparisons[pointId].nearby, then points[pointId].neighbourRelations.curatedComparisonDisplay, then learningComparisonDisplay",
      markerMeaning: "Black markers are learning comparison relationships only; their clinical accuracy remains unreviewed in this prototype.",
    },
    points,
  };
}

function build() {
  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, "utf8"));
  const sourcePoints = assertSourcePoints(source);
  const points = new Map();
  const meridianPointCounts = new Map(source.meridians.map((meridian) => [meridian.code, meridian.points.length]));

  for (const sourcePoint of sourcePoints) {
    const { plan, range: assignedRange, routeFraction } = routeAssignment(sourcePoint.code, sourcePoint.number);
    const sideMode = plan.sideMode;
    if (sideMode === "bilateral" && !BILATERAL_CODES.has(sourcePoint.code)) throw new Error(`${sourcePoint.id} has unsupported bilateral mode.`);
    if (sideMode === "midline" && !MIDLINE_CODES.has(sourcePoint.code)) throw new Error(`${sourcePoint.id} has unsupported midline mode.`);
    const assignment = { plan, range: assignedRange, routeFraction };
    const sides = sideMode === "bilateral" ? ["left", "right"] : ["midline"];
    points.set(sourcePoint.id, {
      id: sourcePoint.id,
      name: sourcePoint.name,
      meridian: {
        code: sourcePoint.code,
        name: sourcePoint.meridianName,
        pointCount: meridianPointCounts.get(sourcePoint.code),
      },
      number: sourcePoint.number,
      laterality: sideMode,
      coordinateStatus: "estimated",
      reviewStatus: "needs-anatomical-and-model-fit-review",
      sourceMapping: {
        routeTemplate: assignedRange.routeId,
        numberRange: [assignedRange.start, assignedRange.end],
        interpolation: "number-to-route-progress",
      },
      instances: sides.map((side) => makeInstance(sourcePoint, assignment, side)),
    });
  }

  const surface = loadFinalSurface();
  const projection = projectInstancesToFinalSurface(points, surface);
  addNeighbourRelations(points);
  const output = {
    version: "0.2.0-viewer-prototype",
    generatedBy: "scripts/build-acupoint-3d-prototype.mjs",
    source: {
      file: "assets/json/meridians.json",
      version: source.version,
      canonicalPointCount: sourcePoints.length,
    },
    purpose: "Unreviewed full-coverage 3D marker-routing foundation for MeridianPoints.",
    clinicalSafety: {
      clinicalAccuracyClaimed: false,
      status: "prototype-estimates-only",
      requiredBeforeLearningUse: [
        "Have a qualified acupuncture/anatomy reviewer approve each projected point anchor.",
        "Author curated comparison-marker relationships per learning screen.",
      ],
    },
    coordinateSpace: {
      asset: "assets/models/meridian-anatomy-v1.glb",
      units: "asset-local units",
      axes: {
        x: "negative = asset anatomical-left convention; positive = asset anatomical-right convention",
        y: "positive = superior",
        z: "positive = anterior",
      },
      anchorMeaning: "Raw route estimates are snapped to the nearest triangle of Skin_Body with its outward interpolated normal. Viewers apply marker.offsetAlongNormal.",
      mirrorPolicy: "Bilateral routes are authored once on asset-left and mirrored across x = 0 to make concrete left/right instances.",
    },
    statusVocabulary: {
      coordinateStatus: {
        estimated: "Generated from route templates and snapped to the current Skin_Body mesh; not clinically or anatomically reviewed.",
      },
      reviewStatus: {
        "needs-anatomical-and-model-fit-review": "Requires anatomical review and fit validation against the final rendered body.",
        "not-approved-for-comparison-display": "A geometric candidate only; do not render as a learning comparison marker.",
        "not-a-clinical-neighbour-claim": "Sequence order is data ordering, not a localisation relationship.",
      },
    },
    markerDefaults: {
      targetColor: "#e63838",
      comparisonColor: "#060807",
      radius: 0.018,
      offsetAlongNormal: 0.008,
    },
    surfaceProjection: projection,
    surfaceRoutes: makeSurfaceRoutes(),
    points: Object.fromEntries(points),
    coverage: {
      canonicalPointCount: sourcePoints.length,
      canonicalPointCoverage: "361/361",
      bilateralCanonicalPointCount: 309,
      bilateralMarkerInstanceCount: 618,
      midlineCanonicalPointCount: 52,
      midlineMarkerInstanceCount: 52,
      totalMarkerInstanceCount: 670,
      allAnchorStatuses: "estimated",
      allPointReviewStatuses: "needs-anatomical-and-model-fit-review",
      routeCount: Object.keys(makeSurfaceRoutes()).length,
      surfaceProjection: projection,
    },
  };
  const viewerDataset = makeViewerDataset(output);
  validate(viewerDataset, sourcePoints);
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(viewerDataset, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUTPUT_PATH)}`);
  console.log(`Coverage: ${viewerDataset.coverage.canonicalPointCoverage}; ${viewerDataset.coverage.totalMarkerInstanceCount} marker instances; ${viewerDataset.coverage.routeCount} explicit surface routes.`);
  console.log(`Skin projection: median ${projection.medianDistance}; p95 ${projection.p95Distance}; max ${projection.maximumDistance}.`);
}

build();
