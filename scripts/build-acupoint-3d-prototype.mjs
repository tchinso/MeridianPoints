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
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = path.join(ROOT, "assets", "json", "meridians.json");
const OUTPUT_PATH = path.join(ROOT, "assets", "json", "acupoint-3d.json");
const MODEL_PATH = path.join(ROOT, "assets", "models", "meridian-anatomy-v1.glb");
const SURFACE_MESH_NAME = "Skin_Body";

const ROUND_DIGITS = 6;
const BILATERAL_CODES = new Set(["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR"]);
const MIDLINE_CODES = new Set(["CV", "GV"]);
// A reviewed raw route node may carry the outward direction implied by its
// written location (for example, anterior, posterolateral, or medial). A
// purely nearest-triangle projection can otherwise jump through a narrow limb
// or torso to the opposite surface. Explicit reviewer constraints remain
// authoritative. For all directionally-described template nodes, the guarded
// fallback below only replaces an *opposite-facing* nearest triangle when a
// similarly close, same-side alternative exists; ambiguous cases stay put and
// are surfaced in the generated audit instead of being silently moved.
const AUTO_DIRECTION_GUARD_TRIGGER = -0.20;
const AUTO_DIRECTION_GUARD_MIN_ALIGNMENT = 0.45;
const AUTO_DIRECTION_GUARD_MAX_EXTRA_DISTANCE = 0.04;
const AUTO_DIRECTION_GUARD_MAX_VERTICAL_DRIFT = 0.08;
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
  return { document, binary, glb };
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

function scenePathToNode(document, targetIndex) {
  const nodes = document.nodes || [];
  const visit = (index, pathNodes) => {
    if (index === targetIndex) return [...pathNodes, index];
    for (const child of nodes[index]?.children || []) {
      const found = visit(child, [...pathNodes, index]);
      if (found) return found;
    }
    return null;
  };
  for (const scene of document.scenes || []) {
    for (const root of scene.nodes || []) {
      const found = visit(root, []);
      if (found) return found;
    }
  }
  return null;
}

function modelBinding(document, glb, meshIndex) {
  const meshNodeIndex = document.nodes?.findIndex((node) => node.mesh === meshIndex);
  const nodePath = Number.isInteger(meshNodeIndex) && meshNodeIndex >= 0
    ? scenePathToNode(document, meshNodeIndex)
    : null;
  return {
    algorithm: "sha256",
    sha256: createHash("sha256").update(glb).digest("hex").toUpperCase(),
    surfaceMesh: SURFACE_MESH_NAME,
    meshIndex,
    meshNodeIndex,
    sceneNodePath: (nodePath || []).map((index) => ({
      index,
      name: document.nodes[index]?.name || null,
      translation: document.nodes[index]?.translation || [0, 0, 0],
      rotation: document.nodes[index]?.rotation || [0, 0, 0, 1],
      scale: document.nodes[index]?.scale || [1, 1, 1],
      matrix: document.nodes[index]?.matrix || null,
    })),
  };
}

function loadFinalSurface() {
  const { document, binary, glb } = readGlb(MODEL_PATH);
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
    modelBinding: modelBinding(document, glb, meshIndex),
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

function triangleSurfaceNormal(surface, triangle, first, second, third) {
  const { positions, indices, normals } = surface;
  const firstIndex = indices[triangle * 3] * 3;
  const secondIndex = indices[triangle * 3 + 1] * 3;
  const thirdIndex = indices[triangle * 3 + 2] * 3;
  let nx;
  let ny;
  let nz;

  if (normals) {
    nx = normals[firstIndex] * first + normals[secondIndex] * second + normals[thirdIndex] * third;
    ny = normals[firstIndex + 1] * first + normals[secondIndex + 1] * second + normals[thirdIndex + 1] * third;
    nz = normals[firstIndex + 2] * first + normals[secondIndex + 2] * second + normals[thirdIndex + 2] * third;
  } else {
    const ax = positions[firstIndex];
    const ay = positions[firstIndex + 1];
    const az = positions[firstIndex + 2];
    nx = (positions[secondIndex + 1] - ay) * (positions[thirdIndex + 2] - az) - (positions[secondIndex + 2] - az) * (positions[thirdIndex + 1] - ay);
    ny = (positions[secondIndex + 2] - az) * (positions[thirdIndex] - ax) - (positions[secondIndex] - ax) * (positions[thirdIndex + 2] - az);
    nz = (positions[secondIndex] - ax) * (positions[thirdIndex + 1] - ay) - (positions[secondIndex + 1] - ay) * (positions[thirdIndex] - ax);
  }

  return normalise([nx, ny, nz]);
}

function triangleNormalAlignment(surface, triangle, first, second, third, intendedNormal) {
  const { positions, indices, normals } = surface;
  const firstIndex = indices[triangle * 3] * 3;
  const secondIndex = indices[triangle * 3 + 1] * 3;
  const thirdIndex = indices[triangle * 3 + 2] * 3;
  let nx;
  let ny;
  let nz;

  if (normals) {
    nx = normals[firstIndex] * first + normals[secondIndex] * second + normals[thirdIndex] * third;
    ny = normals[firstIndex + 1] * first + normals[secondIndex + 1] * second + normals[thirdIndex + 1] * third;
    nz = normals[firstIndex + 2] * first + normals[secondIndex + 2] * second + normals[thirdIndex + 2] * third;
  } else {
    const ax = positions[firstIndex];
    const ay = positions[firstIndex + 1];
    const az = positions[firstIndex + 2];
    nx = (positions[secondIndex + 1] - ay) * (positions[thirdIndex + 2] - az) - (positions[secondIndex + 2] - az) * (positions[thirdIndex + 1] - ay);
    ny = (positions[secondIndex + 2] - az) * (positions[thirdIndex] - ax) - (positions[secondIndex] - ax) * (positions[thirdIndex + 2] - az);
    nz = (positions[secondIndex] - ax) * (positions[thirdIndex + 1] - ay) - (positions[secondIndex + 1] - ay) * (positions[thirdIndex] - ax);
  }

  const length = Math.hypot(nx, ny, nz);
  return length > 0
    ? (nx * intendedNormal[0] + ny * intendedNormal[1] + nz * intendedNormal[2]) / length
    : Number.NEGATIVE_INFINITY;
}

function isDirectionallyDescribedSurface(surface) {
  return /anterior|posterior|dorsal|palmar|lateral|medial|back|scapular|gluteal|sacral|occiput|temple|brow|forehead|face|cheek|jaw|nose|ear|neck|chest|abdomen/i.test(surface || "");
}

function isLimbSurface(surface) {
  return /upper-arm|forearm|elbow|wrist|hand|palm|finger|thumb|thigh|leg|knee|ankle|foot|toe/i.test(surface || "");
}

function isProjectionMorphologicallyCompatible(sourcePosition, projectedPosition, surface) {
  const [sourceX, sourceY] = sourcePosition;
  const [projectedX, projectedY] = projectedPosition;

  // Do not use an automatic normal correction if it crosses the anatomical
  // midline or moves to a substantially different longitudinal level. A
  // route-specific reviewer can still author an explicit constraint for an
  // exceptional point.
  if (sourceX * projectedX < -0.000001) return false;
  if (Math.abs(sourceY - projectedY) > AUTO_DIRECTION_GUARD_MAX_VERTICAL_DRIFT) return false;

  // On a limb, a candidate that collapses markedly toward the torso is the
  // common signature of a chest/arm or thigh/torso nearest-surface error.
  if (isLimbSurface(surface) && Math.abs(sourceX) > 0.10) {
    return Math.abs(projectedX) >= Math.abs(sourceX) * 0.65;
  }
  return true;
}

function closestDirectionallyCompatibleProjection(point, surface, intendedNormal, minimumNormalAlignment, compatibilityFilter = null) {
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
  let bestAlignment = Number.NEGATIVE_INFINITY;

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
    const candidateDistanceSquared = (px - scratch.x) ** 2 + (py - scratch.y) ** 2 + (pz - scratch.z) ** 2;
    if (candidateDistanceSquared >= bestDistanceSquared) continue;

    const triangle = offset / 3;
    const candidateAlignment = triangleNormalAlignment(
      surface,
      triangle,
      scratch.first,
      scratch.second,
      scratch.third,
      intendedNormal,
    );
    if (candidateAlignment < minimumNormalAlignment) continue;
    if (compatibilityFilter && !compatibilityFilter([scratch.x, scratch.y, scratch.z])) continue;

    bestDistanceSquared = candidateDistanceSquared;
    bestTriangle = triangle;
    bestX = scratch.x;
    bestY = scratch.y;
    bestZ = scratch.z;
    bestFirst = scratch.first;
    bestSecond = scratch.second;
    bestThird = scratch.third;
    bestAlignment = candidateAlignment;
  }

  if (bestTriangle < 0) return null;
  return {
    triangle: bestTriangle,
    position: [bestX, bestY, bestZ],
    barycentric: [bestFirst, bestSecond, bestThird],
    distanceSquared: bestDistanceSquared,
    alignment: bestAlignment,
  };
}

function closestSurfaceProjection(point, surface, projectionOptions = {}) {
  const [px, py, pz] = point;
  const { positions, indices } = surface;
  const intendedNormal = Array.isArray(projectionOptions.intendedNormal)
    ? normalise(projectionOptions.intendedNormal)
    : null;
  const requestedMinimumNormalAlignment = Number(projectionOptions.minimumNormalAlignment);
  const minimumNormalAlignment = intendedNormal && Number.isFinite(requestedMinimumNormalAlignment)
    ? Math.min(0.98, Math.max(-0.98, requestedMinimumNormalAlignment))
    : null;
  const automaticDirectionGuardRequested = Boolean(
    intendedNormal
    && minimumNormalAlignment === null
    && projectionOptions.automaticDirectionGuard,
  );
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

  let selection = "nearest-triangle";
  const nearestDistance = Math.sqrt(bestDistanceSquared);
  const nearestNormalAlignment = intendedNormal
    ? triangleNormalAlignment(surface, bestTriangle, bestFirst, bestSecond, bestThird, intendedNormal)
    : null;
  let normalAlignment = nearestNormalAlignment;
  let automaticDirectionGuard = automaticDirectionGuardRequested ? "not-needed" : "not-requested";

  // Only pay for a second pass when the nearest surface faces away from the
  // source route's intended side. This is important for close anterior and
  // posterior surfaces, as well as the medial/lateral faces of an arm.
  if (intendedNormal && minimumNormalAlignment !== null && normalAlignment < minimumNormalAlignment) {
    const constrained = closestDirectionallyCompatibleProjection(
      point,
      surface,
      intendedNormal,
      minimumNormalAlignment,
    );
    if (constrained) {
      bestDistanceSquared = constrained.distanceSquared;
      bestTriangle = constrained.triangle;
      [bestX, bestY, bestZ] = constrained.position;
      [bestFirst, bestSecond, bestThird] = constrained.barycentric;
      normalAlignment = constrained.alignment;
      selection = "normal-constrained-triangle";
    } else {
      selection = "nearest-triangle-normal-fallback";
    }
  } else if (automaticDirectionGuardRequested && normalAlignment < AUTO_DIRECTION_GUARD_TRIGGER) {
    const guarded = closestDirectionallyCompatibleProjection(
      point,
      surface,
      intendedNormal,
      AUTO_DIRECTION_GUARD_MIN_ALIGNMENT,
      (candidatePosition) => isProjectionMorphologicallyCompatible(
        point,
        candidatePosition,
        projectionOptions.sourceSurface,
      ),
    );
    if (guarded && Math.sqrt(guarded.distanceSquared) <= nearestDistance + AUTO_DIRECTION_GUARD_MAX_EXTRA_DISTANCE) {
      bestDistanceSquared = guarded.distanceSquared;
      bestTriangle = guarded.triangle;
      [bestX, bestY, bestZ] = guarded.position;
      [bestFirst, bestSecond, bestThird] = guarded.barycentric;
      normalAlignment = guarded.alignment;
      selection = "automatic-direction-guard";
      automaticDirectionGuard = "applied";
    } else {
      selection = "nearest-triangle-auto-direction-guard-rejected";
      automaticDirectionGuard = guarded
        ? "rejected-directional-surface-too-far"
        : "rejected-no-compatible-directional-surface";
    }
  }

  const normal = triangleSurfaceNormal(surface, bestTriangle, bestFirst, bestSecond, bestThird);
  return {
    position: [round(bestX), round(bestY), round(bestZ)],
    normal,
    triangle: bestTriangle,
    barycentric: [round(bestFirst), round(bestSecond), round(bestThird)],
    distance: round(Math.sqrt(bestDistanceSquared)),
    nearestDistance: round(nearestDistance),
    nearestNormalAlignment: nearestNormalAlignment === null ? null : round(nearestNormalAlignment),
    normalAlignment: normalAlignment === null ? null : round(normalAlignment),
    minimumNormalAlignment,
    automaticDirectionGuard,
    selection,
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
function node(position, normal, surface, landmark, projection = null) {
  return {
    position,
    normal: normalise(normal),
    surface,
    landmark,
    ...(projection ? { projection } : {}),
  };
}

const n = node;

// A handful of landmarks need a point-level surface target rather than the
// route-wide interpolation that is sufficient for the long, straight portions
// of a channel.  These are authored directly in the current Skin_Body local
// coordinate system (not in the historical template coordinate system used by
// ROUTE_TEMPLATES).  Each target was checked against the point's written
// location and reference image, then against the rendered mesh: the nearby
// triangle must be on the named anatomical side rather than merely the closest
// triangle through a limb, a joint fold, or the thorax.
function surfaceCalibrationNode(position, normal, surface, landmark) {
  return {
    ...node(position, normal, surface, landmark),
    coordinateSpace: "Skin_Body-local",
  };
}

const sn = surfaceCalibrationNode;

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

// Asset-left point targets. `pointCalibrationOverrideFor` mirrors each one
// for the anatomical right side.  These are deliberately limited to places
// where the original route fraction either landed on a neighbouring surface
// (for example a medial elbow instead of the radial/ulnar recess) or collapsed
// two source-distinct points onto one Skin_Body triangle neighbourhood.
// They remain estimated surface fits pending clinical approval; `sourceEvidence`
// continues to carry the exact figure and location text for every point.
const SURFACE_CALIBRATION_OVERRIDES = {
  // Mouth/jaw and lower chest: retain the source-distinct locations after the
  // rounded face and chest surface are projected.
  ST4: sn([-0.045, 1.640, 0.090], [-0.30, 0.20, 0.93], "anterior-cheek", "lateral oral commissure"),
  ST5: sn([-0.070, 1.620, 0.070], [-0.83, -0.31, 0.46], "anterolateral-jaw", "masseter lower-border recess"),
  ST18: sn([-0.120, 1.325, 0.130], [-0.50, 0, 0.85], "anterior-lateral-chest", "fifth intercostal field below nipple"),
  ST19: sn([-0.120, 1.280, 0.130], [-0.50, 0, 0.85], "anterior-lateral-chest", "upper abdominal field, six cun above umbilicus"),

  // The prior distal lower-leg controls sat forward of the skin and projected
  // through the tibia/ankle. These fit the lateral anterior tibial contour at
  // the documented longitudinal sequence from knee to lateral malleolus.
  ST35: sn([-0.130, 0.400, 0.000], [-0.70, 0, 0.70], "lateral-knee", "lateral patellar recess"),
  ST36: sn([-0.140, 0.360, 0.000], [-0.70, 0, 0.70], "anterolateral-leg", "tibialis anterior, three cun below knee"),
  ST37: sn([-0.140, 0.320, 0.000], [-0.70, 0, 0.70], "anterolateral-leg", "upper lower-leg lateral line"),
  ST38: sn([-0.140, 0.280, 0.000], [-0.70, 0, 0.70], "anterolateral-leg", "lower lower-leg lateral line"),
  ST39: sn([-0.140, 0.230, 0.000], [-0.70, 0, 0.70], "anterolateral-leg", "three cun inferior to ST37"),
  ST40: sn([-0.130, 0.200, 0.000], [-0.70, 0, 0.70], "anterolateral-leg", "lateral lower-leg, one cun lateral to ST38"),
  ST43: sn([-0.090, 0.040, 0.126], [0, 1, 0], "dorsal-foot", "second/third metatarsal recess"),
  ST44: sn([-0.100, 0.020, 0.130], [0, 1, 0], "dorsal-toe", "second/third toe web recess"),
  ST45: sn([-0.100, 0.025, 0.140], [0, 1, 0], "second-toe", "second toe lateral nail corner"),

  // Elbow/forearm surface side: avoid a nearest inner-arm result for radial
  // LU5 and preserve the distinct medial biceps-tendon recesses for HT/PC.
  LU5: sn([-0.250, 1.265, 0.015], [-0.70, 0, 0.70], "anterior-lateral-elbow", "radial biceps-tendon recess"),
  LU6: sn([-0.290, 1.160, 0.020], [-0.55, 0.10, 0.83], "anterior-lateral-forearm", "radial forearm, five cun below LU5"),
  LU11: sn([-0.310, 0.780, 0.080], [-0.70, 0.30, 0.60], "thumb", "radial thumbnail corner"),
  HT3: sn([-0.190, 1.250, 0.010], [0.65, 0, 0.76], "anterior-medial-elbow", "ulnar end of antecubital crease"),
  HT4: sn([-0.200, 1.180, 0.000], [0.65, 0, 0.76], "anterior-medial-forearm", "ulnar palmar forearm, 1.5 cun above HT7"),
  HT5: sn([-0.200, 1.145, 0.000], [0.65, 0, 0.76], "anterior-medial-forearm", "ulnar palmar forearm, one cun above HT7"),
  PC2: sn([-0.170, 1.350, 0.000], [0.72, -0.35, 0.60], "axillary-fold", "medial biceps below anterior axillary fold"),
  PC3: sn([-0.190, 1.250, 0.010], [0.65, 0, 0.76], "anterior-medial-elbow", "medial biceps-tendon recess"),
  PC4: sn([-0.190, 1.200, 0.000], [0.65, 0, 0.76], "anterior-medial-forearm", "palmar forearm between flexor tendons"),
  LI6: sn([-0.300, 1.125, -0.010], [-0.90, 0.20, 0.39], "radial-wrist", "radial forearm line above LI5"),
  LI12: sn([-0.270, 1.250, -0.040], [-0.70, 0, -0.70], "lateral-upper-arm", "lateral upper arm, three cun above LI11"),
  LI13: sn([-0.250, 1.300, -0.050], [-0.70, 0, -0.70], "lateral-upper-arm", "lateral upper arm, seven cun above LI11"),
  LI14: sn([-0.250, 1.338, 0.010], [-0.70, 0, 0.70], "lateral-upper-arm", "anterior deltoid border"),
  LI16: sn([-0.200, 1.420, -0.070], [-0.65, 0.13, -0.75], "posterior-shoulder", "acromion/scapular-spine recess"),
  SI5: sn([-0.300, 1.105, -0.050], [-0.70, 0, -0.70], "dorsoulnar-wrist", "ulnar end of the dorsal wrist crease"),
  SI6: sn([-0.300, 1.130, -0.050], [-0.70, 0, -0.70], "dorsoulnar-wrist", "radial edge above the ulnar styloid recess"),
  SI9: sn([-0.220, 1.360, -0.050], [-0.70, 0, -0.70], "posterior-upper-arm", "one cun superior to posterior axillary fold"),
  TE4: sn([-0.281, 1.075, 0.008], [0.45, -0.01, -0.89], "dorsal-wrist", "dorsal wrist crease between third/fourth metacarpals"),
  TE5: sn([-0.300, 1.110, -0.030], [0, 0, -1], "posterolateral-forearm", "dorsal forearm two cun above wrist"),
  TE6: sn([-0.300, 1.140, -0.050], [-0.70, 0, -0.70], "posterolateral-forearm", "dorsal forearm three cun above wrist"),
  TE7: sn([-0.290, 1.170, -0.050], [-0.70, 0, -0.70], "posterolateral-forearm", "ulnar dorsal forearm, one cun medial to TE6"),
  TE13: sn([-0.220, 1.300, -0.070], [-0.70, 0, -0.70], "posterolateral-upper-arm", "posterior deltoid border"),
  TE15: sn([-0.200, 1.360, -0.060], [-0.70, 0, -0.70], "posterior-shoulder", "posterior superior shoulder between GB21 and SI13"),
  TE17: sn([-0.075, 1.670, -0.050], [-0.80, 0, -0.60], "posterior-auricular", "mastoid recess posterior to the earlobe"),
  TE19: sn([-0.075, 1.670, -0.050], [-0.80, 0, -0.60], "posterior-auricular", "upper third of posterior auricular curve"),

  // Scalp, posterior neck, sacral/popliteal, and lateral ankle/foot targets.
  BL4: sn([-0.055, 1.740, 0.090], [-0.63, 0.25, 0.74], "frontal-scalp", "frontal hairline medial third"),
  BL30: sn([-0.055, 0.790, -0.100], [-0.40, 0, -0.90], "sacral", "fourth sacral foramen level"),
  BL40: sn([-0.090, 0.380, -0.080], [0, 0, -1], "popliteal", "popliteal crease center"),
  BL59: sn([-0.140, 0.210, -0.080], [-0.50, 0, -0.86], "posterolateral-leg", "three cun superior to BL60"),
  BL60: sn([-0.140, 0.130, -0.080], [-0.50, 0, -0.86], "posterolateral-leg", "lateral malleolus/Achilles recess"),
  BL61: sn([-0.140, 0.090, -0.080], [-0.50, 0, -0.86], "posterolateral-ankle", "inferior lateral calcaneal recess"),
  BL64: sn([-0.160, 0.045, 0.100], [-0.70, 0.40, 0.30], "lateral-foot", "fifth metatarsal tuberosity border"),
  BL65: sn([-0.160, 0.030, 0.120], [-0.70, 0.40, 0.30], "lateral-foot", "fifth metatarsophalangeal border"),
  GB11: sn([-0.073, 1.692, -0.055], [-0.93, -0.13, -0.35], "posterior-auricular", "mastoid base posterior to ear"),
  GB18: sn([-0.060, 1.760, -0.030], [-0.70, 0.60, -0.30], "parietal-scalp", "superior temporal/parietal scalp"),
  GB19: sn([-0.070, 1.720, -0.060], [-0.80, 0.20, -0.55], "posterior-auricular", "occipital field, 1.5 cun superior to GB20"),
  GB20: sn([-0.080, 1.540, -0.090], [-0.40, 0.20, -0.90], "posterior-neck", "suboccipital trapezius/SCM recess"),
  GB28: sn([-0.200, 0.895, -0.020], [-1, 0, 0], "lateral-hip", "anterior iliac crest lateral field"),
  GB42: sn([-0.120, 0.040, 0.120], [0, 1, 0], "dorsal-foot", "fourth/fifth metatarsal dorsal field"),
  GB43: sn([-0.130, 0.025, 0.130], [0, 1, 0], "dorsal-foot", "fourth/fifth toe web recess"),

  // Medial/lateral foot borders are particularly sensitive to an interior
  // nearest-point snap because the raw source point sits close to both the
  // dorsal and plantar triangles.
  SP3: sn([-0.100, 0.040, 0.100], [0.77, -0.57, -0.29], "medial-foot", "first metatarsal head medial plantar border"),
  SP4: sn([-0.100, 0.065, 0.060], [0.90, -0.38, -0.22], "medial-ankle", "first metatarsal base medial border"),
  SP13: sn([-0.130, 0.820, 0.100], [-0.40, 0, 0.90], "lower-abdomen", "four cun lateral to the midline, 0.7 cun superior to SP12"),
  KI2: sn([-0.100, 0.040, 0.100], [0.77, -0.57, -0.29], "medial-plantar-foot", "navicular tuberosity inferior border"),
  LR7: sn([-0.080, 0.400, -0.040], [0.70, 0, -0.70], "posteromedial-knee", "one cun posterior to SP9 at the medial knee"),
  LR1: sn([-0.120, 0.020, 0.110], [-0.86, -0.38, -0.34], "great-toe", "lateral great-toe nail corner"),
};

function pointCalibrationOverrideFor(pointId, side) {
  const override = SURFACE_CALIBRATION_OVERRIDES[pointId];
  if (!override) return null;
  if (side === "right") return mirrorNode(override);
  return override;
}

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
      // `LocationAndIndications.txt` and LU1–LU4 reference illustrations:
      // LU2 is in the lateral infraclavicular/coracoid fossa; LU1 is directly
      // one cun inferior; LU3–LU4 descend on the anterior-lateral (radial)
      // biceps border from the anterior axillary fold.  These nodes are
      // deliberately raised/lateralised for the arms-down BodyParts3D body.
      n([-0.38, 1.440, 0.060], [-0.48, 0.05, 0.88], "infraclavicular-fossa", "first intercostal / LU2 inferior field", { minimumNormalAlignment: 0.62, sourceReferences: ["assets/images/LU/LU1.webp", "assets/references/LocationAndIndications.txt"] }),
      n([-0.45, 1.480, 0.060], [-0.66, 0.07, 0.75], "deltopectoral-fossa", "lateral clavicle / coracoid field", { minimumNormalAlignment: 0.62, sourceReferences: ["assets/images/LU/LU2.webp", "assets/references/LocationAndIndications.txt"] }),
      n([-0.50, 1.350, 0.000], [-0.90, 0, 0.35], "anterior-lateral-upper-arm", "radial biceps border below anterior axillary fold", { minimumNormalAlignment: 0.66, sourceReferences: ["assets/images/LU/LU3.webp", "assets/references/LocationAndIndications.txt"] }),
      n([-0.55, 1.315, 0.040], [-0.90, 0, 0.35], "anterior-lateral-upper-arm", "radial biceps border, one cun inferior", { minimumNormalAlignment: 0.66, sourceReferences: ["assets/images/LU/LU4.webp", "assets/references/LocationAndIndications.txt"] }),
      n([-0.49, 1.255, 0.145], [-0.20, -0.04, 0.98], "anterior-elbow", "antecubital biceps-tendon region"),
      n([-0.54, 1.160, 0.030], [-0.30, 0, 0.95], "anterior-medial-forearm", "flexor surface"),
      n([-0.59, 1.015, 0.055], [-0.75, 0, 0.66], "radial-wrist", "radial wrist contour"),
      n([-0.71, 0.865, 0.100], [-0.55, 0, 0.84], "thenar-palm", "thenar eminence"),
      n([-0.60, 0.780, 0.120], [-0.90, 0, 0.40], "thumb", "thumb radial nail field"),
    ],
  },
  LI_main: {
    code: "LI",
    sideMode: "bilateral",
    label: "index finger to face",
    nodes: [
      n([-0.640, 0.760, 0.140], [-0.40, 0, 0.92], "index-finger", "radial index nail corner"),
      n([-0.650, 0.810, 0.150], [-0.34, 0, 0.94], "dorsal-hand", "index ray"),
      n([-0.660, 0.890, 0.140], [-0.30, 0, 0.95], "dorsal-hand", "first dorsal interosseous region"),
      n([-0.600, 1.080, 0.040], [-0.52, 0, 0.85], "radial-wrist", "radial dorsal wrist"),
      n([-0.580, 1.190, -0.100], [-0.45, 0, -0.89], "dorsolateral-forearm", "radial forearm"),
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
      // ST41–45: the source figures progress from the ankle over the second
      // ray to the second-toe nail. Values are pre-fit template space; the
      // resulting Skin_Body targets remain distinct at the distal toe.
      n([-0.21, 0.075, 0.120], [-0.45, 0, 0.89], "anterior-ankle", "anterior ankle"),
      n([-0.20, 0.040, 0.180], [-0.12, 0, 0.99], "dorsal-foot", "second metatarsal surface"),
      n([-0.20, 0.020, 0.200], [-0.18, 0, 0.98], "second-toe", "second toe lateral nail field"),
    ],
  },
  SP_main: {
    code: "SP",
    sideMode: "bilateral",
    label: "medial great toe to lateral chest",
    nodes: [
      // SP1–5: hallux nail edge -> first ray -> medial malleolus. This avoids
      // the prior SP1/SP2 collapse while retaining the medial source side.
      n([-0.145, 0.018, 0.150], [0.28, 0, 0.96], "great-toe", "medial hallux nail field"),
      n([-0.170, 0.040, 0.160], [0.52, -0.08, 0.85], "medial-foot", "first metatarsophalangeal / medial first ray"),
      n([-0.170, 0.085, 0.050], [0.78, 0, 0.62], "medial-ankle", "medial malleolus region"),
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
      n([-0.600, 1.200, 0.060], [-0.45, 0, 0.89], "anterior-medial-forearm", "flexor surface"),
      n([-0.610, 1.080, 0.060], [-0.45, 0, 0.89], "ulnar-wrist", "ulnar palmar wrist"),
      n([-0.700, 0.890, 0.130], [-0.50, 0, 0.86], "ulnar-palm", "hypothenar/palm"),
      n([-0.740, 0.800, 0.140], [-0.65, 0, 0.76], "little-finger", "little finger ray"),
      n([-0.750, 0.750, 0.140], [-0.70, 0, 0.70], "little-finger", "little finger nail field"),
    ],
  },
  SI_main: {
    code: "SI",
    sideMode: "bilateral",
    label: "little finger to ear",
    nodes: [
      n([-0.750, 0.750, 0.140], [-0.70, 0, 0.70], "little-finger", "ulnar little-finger nail field"),
      n([-0.730, 0.810, 0.150], [-0.65, 0, 0.76], "dorsal-hand", "ulnar hand"),
      n([-0.700, 0.880, 0.140], [-0.60, 0, 0.80], "dorsal-hand", "ulnar carpus"),
      n([-0.620, 1.080, 0.030], [-0.55, 0, 0.83], "dorsoulnar-wrist", "ulnar dorsal wrist"),
      n([-0.600, 1.130, -0.030], [-0.45, 0, -0.89], "posterolateral-forearm", "ulnar extensor surface"),
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
      // BL63–67: separate fifth-ray points from the fifth-toe nail edge,
      // following the documented progression from lateral foot to little toe.
      n([-0.250, 0.055, 0.130], [-0.52, 0, 0.85], "lateral-foot", "fifth metatarsal base / lateral foot border"),
      n([-0.290, 0.035, 0.160], [-0.62, 0, 0.78], "lateral-foot", "fifth metatarsophalangeal region"),
      n([-0.310, 0.020, 0.160], [-0.72, 0, 0.69], "fifth-toe", "lateral fifth-toe nail field"),
    ],
  },
  KI_main: {
    code: "KI",
    sideMode: "bilateral",
    label: "plantar foot to clavicle",
    nodes: [
      n([-0.19, 0.008, 0.140], [0, -1, 0], "plantar-foot", "plantar arch"),
      n([-0.17, 0.032, 0.160], [0.35, -0.28, 0.89], "medial-plantar-foot", "medial plantar arch"),
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
      n([-0.600, 1.080, 0.070], [0, 0, 1], "palmar-wrist", "palmar wrist"),
      n([-0.670, 0.870, 0.130], [0, 0, 1], "palm", "central palm"),
      n([-0.670, 0.750, 0.140], [0, 0, 1], "middle-finger", "middle-finger nail field"),
    ],
  },
  TE_main: {
    code: "TE",
    sideMode: "bilateral",
    label: "ring finger to temple",
    nodes: [
      n([-0.700, 0.750, 0.140], [0, 0, -1], "ring-finger", "ring finger nail field"),
      n([-0.680, 0.810, 0.150], [0, 0, -1], "dorsal-hand", "ring finger ray"),
      n([-0.660, 0.880, 0.140], [-0.42, 0, -0.91], "dorsal-hand", "dorsal carpus"),
      n([-0.620, 1.080, 0.030], [-0.48, 0, -0.88], "dorsal-wrist", "dorsal wrist"),
      n([-0.610, 1.140, -0.030], [-0.48, 0, -0.88], "posterolateral-forearm", "extensor surface"),
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
      n([-0.250, 0.040, 0.170], [-0.45, 0, 0.89], "dorsal-foot", "fourth metatarsal line"),
      n([-0.260, 0.020, 0.200], [-0.48, 0, 0.88], "fourth-toe", "fourth toe lateral nail field"),
    ],
  },
  LR_main: {
    code: "LR",
    sideMode: "bilateral",
    label: "lateral great toe to sixth intercostal field",
    nodes: [
      // LR1–3: lateral hallux nail edge -> first interspace -> dorsal first/
      // second metatarsal field, rather than a single generic forefoot point.
      n([-0.145, 0.020, 0.150], [-0.25, 0, 0.97], "great-toe", "lateral hallux nail field"),
      n([-0.200, 0.040, 0.160], [-0.36, 0, 0.93], "dorsal-foot", "first interspace / first metatarsal line"),
      n([-0.210, 0.075, 0.100], [-0.32, 0, 0.95], "anterior-ankle", "dorsal first/second metatarsal field"),
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
  // The former key plan skipped LU4 and consequently made LU5–LU10 each
  // inherit the preceding landmark.  These progress values preserve the
  // documented LU1–LU5 chest/upper-arm/elbow sequence and keep the wrist and
  // thenar landmarks distinct on the arms-down reference model.
  LU: { sideMode: "bilateral", ranges: [range(1, 11, "LU_main", [[1, 0], [2, 0.125], [3, 0.25], [4, 0.375], [5, 0.5], [6, 0.625], [7, 0.69], [8, 0.73], [9, 0.75], [10, 0.875], [11, 1]])] },
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
  // PC2 (axillary fold), PC3 (elbow), PC7 (palmar wrist), PC8 (palm), and
  // PC9 (middle-finger tip) each receive their own route landmark rather
  // than inheriting the preceding arm segment.
  PC: { sideMode: "bilateral", ranges: [range(1, 9, "PC_main", [[1, 0], [2, 0.143], [3, 0.429], [4, 0.571], [5, 0.62], [6, 0.67], [7, 0.714], [8, 0.857], [9, 1]])] },
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
  const metadataNode = localFraction < 0.5 ? lower : upper;
  return {
    position: lerpVector(lower.position, upper.position, localFraction).map(round),
    normal: normalise(lerpVector(lower.normal, upper.normal, localFraction)),
    surface: metadataNode.surface,
    landmark: metadataNode.landmark,
    ...(metadataNode.projection ? { projection: metadataNode.projection } : {}),
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
  const calibrationOverride = pointCalibrationOverrideFor(point.id, side);
  const comparisonOverride = EXAMPLE_COMPARISON_OVERRIDES[point.id]?.[side];
  const anchored = calibrationOverride
    ? calibrationOverride
    : comparisonOverride
      ? fitRouteNodeToModel(comparisonOverride)
      : anchorAt(routeNodes, assignment.routeFraction);
  const sideSuffix = side === "left" ? "L" : side === "right" ? "R" : "M";
  const rawAnchor = {
    position: anchored.position,
    normal: anchored.normal,
    surface: anchored.surface,
    landmark: anchored.landmark,
    ...(anchored.coordinateSpace ? { coordinateSpace: anchored.coordinateSpace } : {}),
    ...(anchored.projection ? { projection: anchored.projection } : {}),
    status: "estimated",
    reviewStatus: "needs-anatomical-and-model-fit-review",
    provenance: calibrationOverride
      ? "point-level-surface-calibration-with-source-evidence"
      : comparisonOverride
        ? "user-specified-comparison-layout"
        : anchored.projection
          ? "route-template-interpolation-with-reference-calibration"
          : "route-template-interpolation",
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

function attachmentAuditFor(rawAnchor, projection) {
  const [rawX, rawY, rawZ] = rawAnchor.position;
  const [anchorX, anchorY, anchorZ] = projection.position;
  const flags = [];
  const lateralShift = anchorX - rawX;
  const verticalShift = anchorY - rawY;
  const anteriorPosteriorShift = anchorZ - rawZ;
  const normalAlignment = projection.normalAlignment;

  if (projection.distance > 0.06) flags.push("raw-route-to-surface-distance-over-0.06");
  if (Math.abs(verticalShift) > AUTO_DIRECTION_GUARD_MAX_VERTICAL_DRIFT) flags.push("longitudinal-drift-over-0.08");
  if (Math.abs(rawX) > 0.03 && rawX * anchorX < 0) flags.push("crosses-anatomical-midline");
  if (isLimbSurface(rawAnchor.surface) && Math.abs(rawX) > 0.10 && Math.abs(anchorX) < Math.abs(rawX) * 0.65) {
    flags.push("possible-inward-limb-snap");
  }
  if (Number.isFinite(normalAlignment) && normalAlignment < -0.20) {
    flags.push("projected-surface-opposes-intended-normal");
  } else if (Number.isFinite(normalAlignment) && normalAlignment < AUTO_DIRECTION_GUARD_MIN_ALIGNMENT) {
    flags.push("projected-surface-direction-needs-review");
  }
  if (projection.automaticDirectionGuard.startsWith("rejected")) {
    flags.push("automatic-direction-guard-needs-route-review");
  }

  return {
    status: "estimated",
    reviewStatus: "needs-anatomical-and-model-fit-review",
    sourceSurface: rawAnchor.surface,
    sourceLandmark: rawAnchor.landmark,
    rawToSurfaceDistance: projection.distance,
    unconstrainedNearestDistance: projection.nearestDistance,
    intendedNormalAlignment: normalAlignment,
    unconstrainedNearestNormalAlignment: projection.nearestNormalAlignment,
    automaticDirectionGuard: projection.automaticDirectionGuard,
    lateralShift: round(lateralShift),
    verticalShift: round(verticalShift),
    anteriorPosteriorShift: round(anteriorPosteriorShift),
    flags,
    disposition: flags.length ? "flagged-for-anatomical-and-model-fit-review" : "baseline-checked-still-requires-review",
  };
}

function createProjectionAuditSummary() {
  return {
    status: "estimated",
    reviewStatus: "needs-anatomical-and-model-fit-review",
    method: "Each raw route anchor was compared with its rendered Skin_Body triangle attachment; directional guards only replace an opposite-facing nearest triangle when a nearby morphology-compatible surface is available.",
    instanceCount: 0,
    attachmentAuditCoverage: "0/0",
    flaggedInstanceCount: 0,
    flagCounts: {},
    automaticDirectionGuard: {},
    routes: {},
  };
}

function recordProjectionAudit(summary, instance, audit) {
  summary.instanceCount += 1;
  summary.attachmentAuditCoverage = `${summary.instanceCount}/${summary.instanceCount}`;
  if (audit.flags.length) summary.flaggedInstanceCount += 1;
  for (const flag of audit.flags) summary.flagCounts[flag] = (summary.flagCounts[flag] || 0) + 1;
  summary.automaticDirectionGuard[audit.automaticDirectionGuard] = (summary.automaticDirectionGuard[audit.automaticDirectionGuard] || 0) + 1;

  const routeId = instance.routeId;
  const route = summary.routes[routeId] || {
    instanceCount: 0,
    flaggedInstanceCount: 0,
    flagCounts: {},
    automaticDirectionGuard: {},
  };
  route.instanceCount += 1;
  if (audit.flags.length) route.flaggedInstanceCount += 1;
  for (const flag of audit.flags) route.flagCounts[flag] = (route.flagCounts[flag] || 0) + 1;
  route.automaticDirectionGuard[audit.automaticDirectionGuard] = (route.automaticDirectionGuard[audit.automaticDirectionGuard] || 0) + 1;
  summary.routes[routeId] = route;
}

function projectInstancesToFinalSurface(points, surface) {
  const distances = [];
  const auditSummary = createProjectionAuditSummary();
  for (const point of points.values()) {
    for (const instance of point.instances) {
      const projection = closestSurfaceProjection(instance.rawAnchor.position, surface, {
        // Every template normal is retained as an audit contract. Only a
        // directionally described, non-explicit node can use the conservative
        // automatic guard; explicit reviewer constraints remain opt-in.
        intendedNormal: instance.rawAnchor.normal,
        minimumNormalAlignment: instance.rawAnchor.projection?.minimumNormalAlignment,
        automaticDirectionGuard: !instance.rawAnchor.projection && isDirectionallyDescribedSurface(instance.rawAnchor.surface),
        sourceSurface: instance.rawAnchor.surface,
      });
      distances.push(projection.distance);
      const audit = attachmentAuditFor(instance.rawAnchor, projection);
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
          unconstrainedNearestDistance: projection.nearestDistance,
          normal: "outward-interpolated-skin-normal",
          intendedNormalAlignment: projection.normalAlignment,
          unconstrainedNearestNormalAlignment: projection.nearestNormalAlignment,
          minimumNormalAlignment: projection.minimumNormalAlignment,
          automaticDirectionGuard: projection.automaticDirectionGuard,
          selection: projection.selection,
          status: "estimated",
          reviewStatus: "needs-anatomical-and-model-fit-review",
          audit,
        },
      };
      recordProjectionAudit(auditSummary, instance, audit);
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
    audit: auditSummary,
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

function requiredSourceTextList(point, field) {
  const value = point[field];
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    throw new Error(`${point.id} has no usable source ${field} text.`);
  }
  return [...value];
}

function sourceEvidenceFor(point) {
  if (typeof point.image !== "string" || !point.image.trim()) {
    throw new Error(`${point.id} has no usable source image path.`);
  }
  const absoluteImagePath = path.resolve(ROOT, point.image);
  const sourceRoot = `${ROOT}${path.sep}`;
  if (!absoluteImagePath.startsWith(sourceRoot) || !fs.existsSync(absoluteImagePath)) {
    throw new Error(`${point.id} references a missing source image: ${point.image}`);
  }
  const imageStat = fs.statSync(absoluteImagePath);
  if (!imageStat.isFile() || imageStat.size === 0) {
    throw new Error(`${point.id} has an empty source image: ${point.image}`);
  }
  return {
    image: point.image,
    location: requiredSourceTextList(point, "location"),
    technique: requiredSourceTextList(point, "technique"),
    ...(typeof point.note === "string" && point.note.trim() ? { note: point.note } : {}),
    validation: "source-image-and-location-text-verified-at-generation",
  };
}

function assertSourcePoints(source) {
  if (!Array.isArray(source.meridians)) throw new Error("The source data has no meridian list.");
  const points = source.meridians.flatMap((meridian) => meridian.points.map((point) => ({ ...point, meridianName: meridian.name })));
  const duplicateIds = points.map((point) => point.id).filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicateIds.length) throw new Error(`Duplicate point ids: ${[...new Set(duplicateIds)].join(", ")}`);
  if (source.totalPoints !== points.length) throw new Error(`Expected ${source.totalPoints} source points, found ${points.length}.`);
  points.forEach(sourceEvidenceFor);
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
  const sourcePointsById = new Map(sourcePoints.map((point) => [point.id, point]));
  const binding = output.coordinateSpace?.modelBinding;
  if (!binding
    || binding.algorithm !== "sha256"
    || !/^[A-F0-9]{64}$/.test(binding.sha256 || "")
    || binding.surfaceMesh !== SURFACE_MESH_NAME
    || !Number.isInteger(binding.meshNodeIndex)
    || !Array.isArray(binding.sceneNodePath)
    || !binding.sceneNodePath.length) {
    throw new Error("Output is missing the Skin_Body model fingerprint/transform binding.");
  }
  if (outputIds.length !== sourceIds.size) throw new Error(`Output has ${outputIds.length} canonical points; expected ${sourceIds.size}.`);
  for (const id of sourceIds) if (!output.points[id]) throw new Error(`Missing output point ${id}.`);

  let bilateralInstances = 0;
  let midlineInstances = 0;
  for (const point of Object.values(output.points)) {
    const sourcePoint = sourcePointsById.get(point.id);
    const expectedEvidence = sourceEvidenceFor(sourcePoint);
    const expectedInstances = point.laterality === "bilateral" ? 2 : 1;
    if (point.instances.length !== expectedInstances) throw new Error(`${point.id} has incorrect instance count.`);
    if (point.coordinateStatus !== "estimated" || point.reviewStatus !== "needs-anatomical-and-model-fit-review") {
      throw new Error(`${point.id} is missing its explicit estimated/review labels.`);
    }
    if (!point.sourceEvidence
      || point.sourceEvidence.image !== expectedEvidence.image
      || JSON.stringify(point.sourceEvidence.location) !== JSON.stringify(expectedEvidence.location)
      || JSON.stringify(point.sourceEvidence.technique) !== JSON.stringify(expectedEvidence.technique)) {
      throw new Error(`${point.id} lost its source image/location/technique evidence.`);
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
      if (!Number.isFinite(instance.anchor.surfaceAttachment.unconstrainedNearestDistance)) {
        throw new Error(`${instance.instanceId} is missing its nearest-surface audit distance.`);
      }
      const attachment = instance.anchor.surfaceAttachment;
      if (!Number.isInteger(attachment.triangle) || attachment.triangle < 0 || attachment.triangle >= output.surfaceProjection.triangleCount) {
        throw new Error(`${instance.instanceId} has an invalid Skin_Body triangle attachment.`);
      }
      if (!Array.isArray(attachment.barycentric) || attachment.barycentric.length !== 3
        || attachment.barycentric.some((value) => !Number.isFinite(value))
        || Math.abs(attachment.barycentric.reduce((sum, value) => sum + value, 0) - 1) > 0.00001) {
        throw new Error(`${instance.instanceId} has an invalid Skin_Body barycentric attachment.`);
      }
      if (!attachment.audit || attachment.audit.status !== "estimated"
        || attachment.audit.reviewStatus !== "needs-anatomical-and-model-fit-review"
        || !Array.isArray(attachment.audit.flags)
        || !Number.isFinite(attachment.audit.rawToSurfaceDistance)
        || !Number.isFinite(attachment.audit.unconstrainedNearestDistance)) {
        throw new Error(`${instance.instanceId} is missing its per-anchor projection audit.`);
      }
      if (!Number.isFinite(attachment.intendedNormalAlignment)
        || !Number.isFinite(attachment.unconstrainedNearestNormalAlignment)) {
        throw new Error(`${instance.instanceId} is missing its normal-direction audit.`);
      }
      if (instance.rawAnchor.projection) {
        const requiredAlignment = instance.rawAnchor.projection.minimumNormalAlignment;
        const { intendedNormalAlignment, minimumNormalAlignment, selection } = instance.anchor.surfaceAttachment;
        if (!Number.isFinite(requiredAlignment) || requiredAlignment < -1 || requiredAlignment > 1) {
          throw new Error(`${instance.instanceId} has an invalid directional projection constraint.`);
        }
        if (minimumNormalAlignment !== requiredAlignment || !Number.isFinite(intendedNormalAlignment)) {
          throw new Error(`${instance.instanceId} lost its directional projection audit data.`);
        }
        if (intendedNormalAlignment + 0.000001 < requiredAlignment || selection === "nearest-triangle-normal-fallback") {
          throw new Error(`${instance.instanceId} did not reach its intended surface direction.`);
        }
      }
      if (instance.laterality === "midline") midlineInstances += 1;
      else bilateralInstances += 1;
    }
  }
  if (bilateralInstances !== 618 || midlineInstances !== 52) {
    throw new Error(`Unexpected instance coverage: ${bilateralInstances} bilateral, ${midlineInstances} midline.`);
  }
  const projectionAudit = output.surfaceProjection?.audit;
  if (!projectionAudit || projectionAudit.instanceCount !== bilateralInstances + midlineInstances
    || projectionAudit.attachmentAuditCoverage !== "670/670"
    || Object.keys(projectionAudit.routes || {}).length !== Object.keys(output.surfaceRoutes).length) {
    throw new Error("The full-surface projection audit does not cover every generated attachment.");
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
      // Preserve the exact 2D figure and written location/technique that the
      // route estimate was derived against. This is evidence linkage, not an
      // assertion that the generated 3D anchor has received clinical approval.
      sourceEvidence: sourceEvidenceFor(sourcePoint),
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
      modelBinding: surface.modelBinding,
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
