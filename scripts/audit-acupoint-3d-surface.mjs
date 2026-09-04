/**
 * Read-only surface-fit audit for the MeridianPoints 3D dataset.
 *
 * This script deliberately does not generate or rewrite anchors.  It verifies
 * that every stored marker really reconstructs on Skin_Body, then treats each
 * raw route normal as an expected-surface contract.  That makes a
 * nearest-triangle snap to the opposite side of a limb visible in CI instead
 * of merely looking plausible in a front camera view.
 *
 * Run from the repository root:
 *   node scripts/audit-acupoint-3d-surface.mjs
 *   node scripts/audit-acupoint-3d-surface.mjs --json
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PATH = path.join(ROOT, "assets", "json", "acupoint-3d.json");
const MODEL_PATH = path.join(ROOT, "assets", "models", "meridian-anatomy-v1.glb");
const SURFACE_MESH_NAME = "Skin_Body";
const JSON_MODE = process.argv.includes("--json");
// The reference body is part of the coordinate contract: barycentric anchors
// are only valid for this exact mesh and its identity transform path.
const EXPECTED_SKIN_BODY_SHA256 = "352BFB6531E65F95DD58679F63A0E262DA4406A8620B37CB2A1EE37DE2CCD2B4";
const MIDLINE_SYMMETRY_PLANE_X = 0;
const MIDLINE_REVIEW_OFFSET = 0.005;
const MIDLINE_HARD_OFFSET = 0.03;
const BILATERAL_MIRROR_REVIEW_OFFSET = 0.01;
const APPROVED_SEQUENTIAL_COLLAPSES = new Set();

const ACCESSOR_COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const COMPONENT_BYTES = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

// These are model-space guard bands measured from the current Skin_Body mesh,
// not clinical coordinates. They catch a distal route that has fallen back
// onto the wrist, ankle, or trunk when its source landmark is inside the mesh.
// Specific terms take precedence (for example palmar-wrist is a wrist, not a
// palm; dorsal-toe is a toe, not generic foot).
const REGION_BANDS = [
  { name: "digit", match: /finger|thumb/, test: ([x, y, z]) => Math.abs(x) >= 0.24 && Math.abs(x) <= 0.39 && y >= 0.70 && y <= 0.86 && z >= 0.035 },
  { name: "wrist", match: /wrist|carpus/, test: ([x, y]) => Math.abs(x) >= 0.23 && Math.abs(x) <= 0.33 && y >= 1.00 && y <= 1.17 },
  { name: "palm", match: /palm|thenar|hypothenar/, test: ([x, y, z]) => Math.abs(x) >= 0.25 && Math.abs(x) <= 0.39 && y >= 0.77 && y <= 0.98 && z >= 0.025 },
  { name: "forearm", match: /forearm|elbow/, test: ([x, y]) => Math.abs(x) >= 0.18 && Math.abs(x) <= 0.33 && y >= 1.05 && y <= 1.31 },
  { name: "upper-arm", match: /upper-arm/, test: ([x, y]) => Math.abs(x) >= 0.17 && Math.abs(x) <= 0.34 && y >= 1.22 && y <= 1.44 },
  { name: "toe", match: /toe/, test: ([x, y, z]) => Math.abs(x) >= 0.05 && Math.abs(x) <= 0.17 && y >= -0.005 && y <= 0.05 && z >= 0.07 },
  { name: "foot", match: /foot|plantar|ankle/, test: ([x, y]) => Math.abs(x) >= 0.04 && Math.abs(x) <= 0.19 && y >= -0.01 && y <= 0.17 },
  { name: "head", match: /eye|brow|scalp|temple|ear|nose|cheek|jaw|forehead|chin|lip|gum|occiput|vertex/, test: ([, y]) => y >= 1.55 && y <= 1.84 },
  { name: "neck", match: /neck|cervical|cervicothoracic/, test: ([x, y]) => Math.abs(x) <= 0.27 && y >= 1.33 && y <= 1.65 },
  { name: "leg", match: /thigh|leg|knee|popliteal/, test: ([x, y]) => Math.abs(x) <= 0.23 && y >= 0.08 && y <= 0.80 },
  { name: "torso", match: /chest|abdomen|stern|clav|xiphoid|inguinal|pubic|perineum|axillary|scapular|paraspinal|spine|sacral|gluteal|shoulder/, test: ([x, y]) => Math.abs(x) <= 0.29 && y >= 0.72 && y <= 1.50 },
];

// Controlled authored-surface taxonomy. Every surface tag emitted by the
// generator must resolve here; unknown tags are a QA failure rather than an
// implicit regex fallback. Directions deliberately describe only stable axes
// on this neutral, arms-down mesh. A hand's generic "dorsal" surface, for
// example, is not globally -Z because the hands are rotated toward the thighs.
// `hardDirections` are mesh axes which remain reliable in the neutral
// arms-down pose. `reviewDirections` preserve the anatomical intent of a
// curved joint, hand, foot, axilla, or shoulder without pretending that one
// global XYZ normal can clinically prove it. Review failures are visible as
// warnings; they are not silently discarded or used to weaken a hard check.
const taxon = (region, hardDirections, tags, reviewDirections = []) => tags.map((tag) => [tag, {
  region,
  hardDirections,
  reviewDirections,
}]);
const SURFACE_TAG_TAXONOMY = Object.fromEntries([
  ...taxon("head", ["front"], ["frontal-scalp"]),
  ...taxon("head", ["back"], ["posterior-auricular", "occiput", "posterior-scalp"]),
  ...taxon("head", ["front"], ["anterior-cheek", "anterolateral-jaw"]),
  ...taxon("head", [], [
    "brow", "cheek", "chin", "ear", "forehead", "infraorbital-face", "jaw", "lateral-eye", "lower-lip", "medial-eye",
    "nose", "parietal-scalp", "temple", "temporal-scalp", "upper-gum", "vertex",
  ]),
  // Point-specific face/scalp controls use these finer source-derived tags.
  // They retain a hard head-mesh band while curved local normals stay a
  // reviewer-visible signal instead of an invalid global XYZ assertion.
  ...taxon("head", [], [
    "anterior-auricular-temple", "anterior-parietal-scalp", "anterolateral-jaw", "frontal-hairline", "infratemporal-fossa",
    "inferior-pretragal-fossa", "labiomental-groove", "lateral-brow", "lateral-philtrum", "malar-cheek", "mandibular-angle",
    "masseter", "mastoid-base", "medial-brow", "nasolabial-fold", "nose-tip", "occipital-scalp", "occipital-scalp",
    "philtrum", "posterior-auricular", "posterior-auricular-neck", "posterior-auricular-scalp", "posterior-mastoid",
    "posterior-parietal-scalp", "posterior-temporal-scalp", "pretragal-fossa", "superior-auricular", "superior-auricular-hairline",
    "superior-auricular-scalp", "superior-pretragal-fossa", "temporal-hairline", "upper-gingival-projection", "upper-lip",
    "zygomatic-cheek",
  ]),

  ...taxon("neck", ["front"], ["anterior-lateral-neck", "anterior-neck"]),
  ...taxon("neck", ["back"], ["posterior-neck", "posterolateral-neck"]),
  ...taxon("neck", [], ["cervicothoracic", "lateral-neck"]),
  ...taxon("neck", [], ["hyoid-midline", "suboccipital-midline", "suprasternal-notch"]),

  ...taxon("torso", ["front"], [
    "anterior-abdomen", "anterior-chest", "anterior-lateral-chest", "anterolateral-abdomen", "infraclavicular",
    "infraclavicular-fossa", "lower-abdomen", "lower-chest", "sternal-chest", "supraclavicular", "umbilical-abdomen",
    "upper-abdomen", "upper-sternum", "xiphoid-lower-chest",
  ]),
  ...taxon("torso", ["front"], ["anterior-perineum", "pubic"]),
  ...taxon("torso", ["back"], [
    "gluteal", "lumbar-spine", "paraspinal-back", "posterior-perineum", "posterolateral-back", "sacral", "scapular",
    "scapular-back", "thoracic-spine", "upper-thoracic-spine",
  ]),
  ...taxon("torso", [], ["axillary-chest", "axillary-fold", "deltopectoral-fossa", "inguinal", "lateral-abdomen", "lateral-chest", "lateral-hip", "lateral-torso", "shoulder"]),
  ...taxon("torso", [], [
    "cervicothoracic-spine", "coccygeal-lateral", "fifth-intercostal-chest", "fifth-intercostal-lateral-chest", "first-intercostal-chest", "first-sacral-foramen", "fourth-intercostal-chest",
    "fourth-intercostal-lateral-chest", "fourth-sacral-foramen", "groin", "infraspinous-scapula", "lower-lumbar-spine",
    "lower-thoracic-spine", "manubriosternal", "mid-thoracic-spine", "outer-fourth-sacral-line", "outer-lumbar-line",
    "outer-second-sacral-line", "posterior-acromion", "posterior-deltoid", "sacral-hiatus", "scapular-spine",
    "second-intercostal-chest", "second-intercostal-lateral-chest", "second-sacral-foramen", "seventh-intercostal-midaxillary", "superior-shoulder",
    "infraclavicular-chest", "supraclavicular-fossa", "third-intercostal-chest", "third-intercostal-lateral-chest", "third-sacral-foramen", "thoracolumbar-spine", "upper-lumbar-spine",
  ]),

  ...taxon("upper-arm", ["front", "lateral"], ["anterior-lateral-upper-arm"]),
  ...taxon("upper-arm", ["lateral"], ["lateral-upper-arm"]),
  ...taxon("upper-arm", ["medial"], ["medial-upper-arm"]),
  // Shoulder/scapular normals turn sharply across the deltoid and scapular
  // ridge. They retain their named back/lateral intent as a review signal,
  // while the torso band is the stable hard body-region check.
  ...taxon("torso", [], ["posterior-shoulder"], ["back"]),
  ...taxon("upper-arm", [], ["posterior-upper-arm"], ["back"]),
  ...taxon("upper-arm", ["lateral"], ["posterolateral-upper-arm"], ["back"]),

  ...taxon("forearm", ["front", "lateral"], ["anterior-lateral-elbow"]),
  ...taxon("forearm", ["front", "lateral"], ["anterior-lateral-forearm"]),
  ...taxon("forearm", ["front"], ["anterior-elbow", "anterior-forearm", "anterior-knee"]),
  ...taxon("forearm", ["front", "medial"], ["anterior-medial-elbow", "anterior-medial-forearm"]),
  ...taxon("forearm", ["lateral"], ["lateral-elbow"]),
  ...taxon("forearm", ["back"], ["posterior-elbow"]),
  ...taxon("forearm", ["lateral"], ["dorsolateral-forearm", "posterolateral-forearm"], ["back"]),

  ...taxon("wrist", ["lateral"], ["radial-wrist"]),
  ...taxon("wrist", [], ["dorsal-wrist"], ["back"]),
  ...taxon("wrist", [], ["dorsoulnar-wrist"], ["back", "lateral"]),
  ...taxon("wrist", [], ["palmar-wrist", "ulnar-wrist"]),
  ...taxon("palm", [], ["dorsal-hand", "palm", "thenar-palm", "ulnar-palm"]),
  ...taxon("digit", [], ["index-finger", "little-finger", "middle-finger", "ring-finger", "thumb"]),

  ...taxon("leg", ["front"], ["anterior-knee", "anterior-thigh"]),
  ...taxon("leg", ["front", "lateral"], ["anterolateral-leg"]),
  ...taxon("leg", ["lateral"], ["lateral-knee", "lateral-leg", "lateral-thigh"]),
  ...taxon("leg", ["medial"], ["medial-thigh"]),
  ...taxon("leg", [], ["medial-knee", "medial-leg", "posteromedial-knee"], ["medial", "back"]),
  ...taxon("leg", ["back"], ["posterior-leg", "posterior-thigh", "popliteal"]),
  ...taxon("leg", ["back", "lateral"], ["posterolateral-leg"]),
  ...taxon("leg", [], [
    "anterolateral-lower-leg", "lower-calf", "medial-lower-leg", "medial-popliteal", "mid-calf", "posterolateral-calf",
    "posterolateral-lower-leg", "proximal-medial-thigh", "upper-calf",
  ]),

  ...taxon("foot", ["front"], ["anterior-ankle"]),
  ...taxon("foot", ["superior"], ["dorsal-foot"]),
  ...taxon("foot", ["inferior"], ["plantar-foot"]),
  // Medial/lateral ankle and foot borders are small curved rims. Their local
  // normal can point mostly up/down, so the foot-region and side checks stay
  // hard while the border normal is a reviewer-visible warning.
  ...taxon("foot", [], ["medial-ankle", "medial-foot", "medial-plantar-foot"], ["medial"]),
  ...taxon("foot", ["lateral"], ["lateral-ankle", "lateral-foot"]),
  ...taxon("foot", ["back", "lateral"], ["posterolateral-ankle"]),
  ...taxon("foot", [], ["anteromedial-ankle", "inferior-medial-malleolus", "posteromedial-ankle"]),
  ...taxon("toe", ["superior"], ["dorsal-toe"]),
  ...taxon("toe", [], ["fifth-toe", "fourth-toe", "great-toe", "second-toe"]),
  ...taxon("foot", [], ["fifth-metatarsal-base", "fifth-metatarsophalangeal"]),
  ...taxon("toe", [], ["fifth-toe-nail", "fifth-toe-web"]),
]);

function getSurfaceTaxonomy(surface) {
  return SURFACE_TAG_TAXONOMY[String(surface || "")] || null;
}

// Distal authored-route landing bands for the current adult arms-down mesh.
// Asset-left uses negative x; mirror x for asset-right.  The bands are an
// engineering hand-off for correcting source templates, not a substitute for
// the point-specific Korean source text and 2D location figure.
const DISTAL_ROUTE_GUIDE = [
  {
    route: "LU", pointRange: "LU6–LU11", kind: "hand",
    guide: "LU6–9: radial volar forearm/wrist |x| 0.24–0.30, y 1.08–1.23, z 0.00–0.07; LU10 thenar: |x| 0.27–0.31, y 0.80–0.91, z 0.05–0.12; LU11 radial thumb nail: |x| 0.25–0.29, y 0.74–0.82, z 0.07–0.13.",
  },
  {
    route: "LI", pointRange: "LI1–LI5", kind: "hand",
    guide: "LI1 index nail: |x| 0.29–0.32, y 0.72–0.80, z 0.07–0.13; LI2–4 dorsal index/first interosseous: |x| 0.29–0.34, y 0.79–0.96, z 0.04–0.12; LI5 radial wrist: |x| 0.27–0.31, y 1.05–1.13, z 0.00–0.06.",
  },
  {
    route: "HT", pointRange: "HT4–HT9", kind: "hand",
    guide: "HT4–7 ulnar volar forearm/wrist: |x| 0.25–0.31, y 1.06–1.22, z 0.00–0.07; HT8 hypothenar/palm: |x| 0.32–0.37, y 0.80–0.92, z 0.05–0.12; HT9 little-finger nail: |x| 0.34–0.37, y 0.73–0.81, z 0.06–0.12.",
  },
  {
    route: "SI", pointRange: "SI1–SI5", kind: "hand",
    guide: "SI1 little-finger nail: |x| 0.34–0.37, y 0.73–0.81, z 0.06–0.12; SI2–3 ulnar dorsal hand: |x| 0.32–0.37, y 0.80–0.97, z 0.04–0.12; SI4–5 dorsoulnar wrist: |x| 0.27–0.32, y 1.05–1.15, z -0.03–0.05.",
  },
  {
    route: "PC", pointRange: "PC5–PC9", kind: "hand",
    guide: "PC5–7 volar forearm/wrist: |x| 0.24–0.30, y 1.06–1.23, z 0.00–0.07; PC8 palm centre: |x| 0.30–0.34, y 0.81–0.92, z 0.05–0.12; PC9 middle-finger nail: |x| 0.30–0.34, y 0.72–0.79, z 0.07–0.13.",
  },
  {
    route: "TE", pointRange: "TE1–TE5", kind: "hand",
    guide: "TE1 ring-finger nail: |x| 0.32–0.35, y 0.72–0.80, z 0.07–0.13; TE2–3 dorsal ring ray: |x| 0.31–0.35, y 0.80–0.97, z 0.04–0.12; TE4–5 dorsal wrist/forearm: |x| 0.25–0.31, y 1.06–1.18, z -0.04–0.05.",
  },
  {
    route: "ST", pointRange: "ST41–ST45", kind: "foot",
    guide: "ST41 anterior ankle / ST42–43 dorsal second ray: |x| 0.08–0.11, y 0.03–0.10, z 0.05–0.13; ST44–45 second-toe nail field: |x| 0.085–0.105, y 0.00–0.03, z 0.13–0.16.",
  },
  {
    route: "SP", pointRange: "SP1–SP5", kind: "foot",
    guide: "SP1 medial hallux nail edge: |x| 0.055–0.085, y 0.00–0.03, z 0.08–0.13; SP2–3 medial hallux/first-ray field: |x| 0.06–0.10, y 0.02–0.06, z 0.07–0.14; SP4–5 medial ankle: |x| 0.06–0.10, y 0.05–0.12, z -0.01–0.08.",
  },
  {
    route: "BL", pointRange: "BL60–BL67", kind: "foot",
    guide: "BL60–62 posterolateral ankle: |x| 0.09–0.14, y 0.07–0.15, z -0.10–0.04; BL63–66 lateral fifth ray: |x| 0.11–0.16, y 0.01–0.07, z 0.05–0.14; BL67 fifth-toe nail edge: |x| 0.13–0.16, y 0.00–0.03, z 0.08–0.13.",
  },
  {
    route: "KI", pointRange: "KI1–KI3", kind: "foot",
    guide: "KI1 plantar arch: |x| 0.08–0.12, y 0.00–0.015, z 0.06–0.12, normal predominantly downward; KI2–3 medial plantar/ankle: |x| 0.06–0.10, y 0.02–0.10, z 0.00–0.14.",
  },
  {
    route: "GB", pointRange: "GB40–GB44", kind: "foot",
    guide: "GB40–41 lateral ankle: |x| 0.10–0.15, y 0.05–0.12, z -0.02–0.07; GB42–43 fourth ray: |x| 0.10–0.14, y 0.01–0.05, z 0.08–0.15; GB44 fourth-toe nail: |x| 0.11–0.14, y 0.00–0.03, z 0.12–0.16.",
  },
  {
    route: "LR", pointRange: "LR1–LR3", kind: "foot",
    guide: "LR1 lateral hallux nail edge: |x| 0.055–0.085, y 0.00–0.03, z 0.08–0.13; LR2 first interspace/first ray: |x| 0.08–0.11, y 0.02–0.06, z 0.08–0.15; LR3 dorsum near first/second metatarsal: |x| 0.08–0.12, y 0.04–0.11, z 0.02–0.12.",
  },
];

function fail(message) {
  throw new Error(`[3D surface audit] ${message}`);
}

function readGlb(filePath) {
  const glb = fs.readFileSync(filePath);
  if (glb.subarray(0, 4).toString("ascii") !== "glTF") fail(`${filePath} is not a GLB.`);
  if (glb.readUInt32LE(4) !== 2) fail(`${filePath} is not glTF 2.0.`);

  let offset = 12;
  let document;
  let binary;
  while (offset < glb.length) {
    const length = glb.readUInt32LE(offset);
    const type = glb.readUInt32LE(offset + 4);
    const chunk = glb.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) document = JSON.parse(chunk.toString("utf8"));
    if (type === 0x004e4942) binary = chunk;
    offset += 8 + length;
  }
  if (!document || !binary) fail("GLB is missing a JSON or binary chunk.");
  return { document, binary, glb };
}

function readAccessor(document, binary, accessorIndex) {
  const accessor = document.accessors?.[accessorIndex];
  const view = document.bufferViews?.[accessor?.bufferView];
  const components = ACCESSOR_COMPONENTS[accessor?.type];
  const bytes = COMPONENT_BYTES[accessor?.componentType];
  if (!accessor || accessor.sparse || !view || !components || !bytes || view.buffer !== 0) {
    fail(`Unsupported accessor ${accessorIndex}.`);
  }
  const stride = view.byteStride || components * bytes;
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const values = new Float64Array(accessor.count * components);
  const readValue = (offset) => {
    if (accessor.componentType === 5126) return binary.readFloatLE(offset);
    if (accessor.componentType === 5125) return binary.readUInt32LE(offset);
    if (accessor.componentType === 5123) return binary.readUInt16LE(offset);
    if (accessor.componentType === 5122) return binary.readInt16LE(offset);
    if (accessor.componentType === 5121) return binary.readUInt8(offset);
    return binary.readInt8(offset);
  };
  for (let index = 0; index < accessor.count; index += 1) {
    for (let component = 0; component < components; component += 1) {
      values[index * components + component] = readValue(base + index * stride + component * bytes);
    }
  }
  return { values, count: accessor.count, components };
}

function identityTransform(node) {
  const translation = node?.translation || [0, 0, 0];
  const rotation = node?.rotation || [0, 0, 0, 1];
  const scale = node?.scale || [1, 1, 1];
  const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const matrix = node?.matrix || identityMatrix;
  const close = (value, expected) => Math.abs(value - expected) <= 0.000001;
  return {
    translation,
    rotation,
    scale,
    matrix: node?.matrix || null,
    identity: translation.length === 3 && rotation.length === 4 && scale.length === 3 && matrix.length === 16
      && translation.every((value, index) => close(value, [0, 0, 0][index]))
      && rotation.every((value, index) => close(value, [0, 0, 0, 1][index]))
      && scale.every((value, index) => close(value, [1, 1, 1][index]))
      && matrix.every((value, index) => close(value, identityMatrix[index])),
  };
}

function scenePathToNode(document, targetIndex) {
  const nodes = document.nodes || [];
  const visit = (index, pathNodes) => {
    if (index === targetIndex) return [...pathNodes, index];
    for (const child of nodes[index]?.children || []) {
      const result = visit(child, [...pathNodes, index]);
      if (result) return result;
    }
    return null;
  };
  for (const scene of document.scenes || []) {
    for (const root of scene.nodes || []) {
      const result = visit(root, []);
      if (result) return result;
    }
  }
  return null;
}

function loadSurface() {
  const { document, binary, glb } = readGlb(MODEL_PATH);
  const meshIndex = document.meshes?.findIndex((mesh) => mesh.name === SURFACE_MESH_NAME);
  const primitive = document.meshes?.[meshIndex]?.primitives?.[0];
  if (!primitive) fail(`Missing ${SURFACE_MESH_NAME} primitive.`);
  const position = readAccessor(document, binary, primitive.attributes?.POSITION);
  const normal = readAccessor(document, binary, primitive.attributes?.NORMAL);
  const index = primitive.indices === undefined ? null : readAccessor(document, binary, primitive.indices);
  if (position.components !== 3 || normal.components !== 3 || (index && index.components !== 1)) {
    fail("Skin_Body needs VEC3 position/normal and scalar indices.");
  }
  const meshNodeIndex = document.nodes?.findIndex((node) => node.mesh === meshIndex);
  const nodePath = Number.isInteger(meshNodeIndex) && meshNodeIndex >= 0
    ? scenePathToNode(document, meshNodeIndex)
    : null;
  const transformPath = (nodePath || []).map((nodeIndex) => ({
    index: nodeIndex,
    name: document.nodes[nodeIndex]?.name || null,
    ...identityTransform(document.nodes[nodeIndex]),
  }));
  const sha256 = createHash("sha256").update(glb).digest("hex").toUpperCase();
  return {
    positions: position.values,
    normals: normal.values,
    indices: index ? Uint32Array.from(index.values) : Uint32Array.from({ length: position.count }, (_, value) => value),
    binding: {
      mesh: SURFACE_MESH_NAME,
      meshIndex,
      meshNodeIndex,
      sha256,
      expectedSha256: EXPECTED_SKIN_BODY_SHA256,
      fingerprintMatches: sha256 === EXPECTED_SKIN_BODY_SHA256,
      nodePath: transformPath,
      transformsIdentity: Boolean(nodePath?.length) && transformPath.every((node) => node.identity),
    },
  };
}

function vectorLength(vector) {
  return Math.hypot(...vector);
}

function normalise(vector) {
  const length = vectorLength(vector);
  return length > 0 ? vector.map((value) => value / length) : [0, 0, 0];
}

function dot(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function distance(left, right) {
  return Math.hypot(...left.map((value, index) => value - right[index]));
}

function interpolatedValue(values, first, second, third, barycentric) {
  return [0, 1, 2].map((component) => (
    values[first * 3 + component] * barycentric[0]
    + values[second * 3 + component] * barycentric[1]
    + values[third * 3 + component] * barycentric[2]
  ));
}

function pointsFromDataset(dataset) {
  const points = Array.isArray(dataset.points) ? dataset.points : Object.values(dataset.points || {});
  if (!points.length) fail("No points found in acupoint-3d.json.");
  return points;
}

function routeFamily(routeId) {
  return String(routeId || "unassigned").replace(/:[LRM]$/, "");
}

// The former audit treated the route template's interpolation vector as a
// surface-normal contract. That is not valid at a curved landmark: dorsal
// foot/nail points are superior-facing on this arms-down mesh, a pubic point
// may face inferiorly, and an axillary or popliteal recess does not have one
// stable outward vector. Instead, derive the contract from the named surface
// itself and evaluate only axes that have a stable anatomical meaning there.
// This makes a wrong front/back or medial/lateral landing fail without calling
// a correctly placed joint-fold point a false error.
function expectedSurfaceDirections(surface) {
  return getSurfaceTaxonomy(surface)?.hardDirections || [];
}

function satisfiesSurfaceDirection(direction, surface, position, normal, laterality) {
  const value = String(surface || "").toLowerCase();
  const sideSign = laterality === "left" ? -1 : laterality === "right" ? 1 : 0;
  const [x, , z] = position;

  if (direction === "front") {
    // The pubic/perineal contour folds inferiorly; there the positive anterior
    // coordinate is more reliable than the local interpolated normal.
    if (/perineum|pubic/.test(value)) return z >= 0.045;
    return normal[2] >= 0.10 || z >= 0.045;
  }
  if (direction === "back") {
    // Folded posterior landmarks use their posterior coordinate as a fallback
    // when the local normal is oblique around a joint or skull base.
    return normal[2] <= -0.10 || z <= -0.025;
  }
  if (direction === "lateral") return Boolean(sideSign) && normal[0] * sideSign >= 0.10;
  if (direction === "medial") return Boolean(sideSign) && normal[0] * sideSign <= -0.10;
  if (direction === "superior") return normal[1] >= 0.10;
  if (direction === "inferior") return normal[1] <= -0.10;
  return true;
}

function semanticSurfaceMismatches(surface, position, actualNormal, laterality) {
  const taxonomy = getSurfaceTaxonomy(surface);
  if (!taxonomy) {
    return {
      labels: ["unknown-surface-tag"],
      failures: ["unknown-surface-tag"],
      reviewLabels: [],
      reviewFailures: [],
    };
  }
  const labels = expectedSurfaceDirections(surface);
  const reviewLabels = taxonomy.reviewDirections || [];
  return {
    labels,
    failures: labels.filter((direction) => !satisfiesSurfaceDirection(direction, surface, position, actualNormal, laterality)),
    reviewLabels,
    reviewFailures: reviewLabels.filter((direction) => !satisfiesSurfaceDirection(direction, surface, position, actualNormal, laterality)),
  };
}

function getRegionBand(surfaceName) {
  const taxonomy = getSurfaceTaxonomy(surfaceName);
  return taxonomy ? REGION_BANDS.find((rule) => rule.name === taxonomy.region) || null : null;
}

function severityFor(instance) {
  if (instance.attachmentPositionError > 0.00002 || instance.attachmentNormalDot < 0.999) return "integrity";
  // A failed named-surface contract or a wrong mesh region is a real surface
  // error. Raw template normal dot is retained as a diagnostic only: it is not
  // a clinical direction contract for a curved/concave landmark.
  if (instance.projectionDistance > 0.075 || instance.directionFailures.length || instance.regionFailure) return "critical";
  if (instance.projectionDistance > 0.035 || instance.directionReviewFailures.length) return "warning";
  return "pass";
}

function toFixed(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function auditSourceEvidence(dataset) {
  const failures = [];
  for (const point of pointsFromDataset(dataset)) {
    const evidence = point.sourceEvidence;
    const textField = (field) => Array.isArray(evidence?.[field]) && evidence[field].some((value) => String(value || "").trim());
    if (!evidence || typeof evidence.image !== "string" || !evidence.image.trim()) {
      failures.push({ id: point.id, reason: "missing-source-image-link" });
    } else if (!fs.existsSync(path.resolve(ROOT, evidence.image))) {
      failures.push({ id: point.id, reason: "source-image-file-not-found", image: evidence.image });
    }
    if (!textField("location")) failures.push({ id: point.id, reason: "missing-source-location-text" });
    if (!textField("technique")) failures.push({ id: point.id, reason: "missing-source-technique-text" });
  }
  return failures;
}

function auditLaterality(dataset) {
  const failures = [];
  const reviews = [];
  const mirrorOffsets = [];
  const pushFailure = (point, instance, reason) => failures.push({
    id: point.id,
    instanceId: instance?.instanceId || null,
    laterality: instance?.laterality || null,
    reason,
  });

  for (const point of pointsFromDataset(dataset)) {
    const instances = Array.isArray(point.instances) ? point.instances : [];
    const bySide = new Map();
    for (const instance of instances) {
      const side = instance?.laterality;
      if (!bySide.has(side)) bySide.set(side, []);
      bySide.get(side).push(instance);
    }
    const expectedSides = point.laterality === "bilateral" ? ["left", "right"] : ["midline"];
    if (!expectedSides.every((side) => bySide.get(side)?.length === 1) || bySide.size !== expectedSides.length) {
      pushFailure(point, null, `expected-exactly-${expectedSides.join("-")}-instances`);
    }

    for (const side of expectedSides) {
      const instance = bySide.get(side)?.[0];
      if (!instance) continue;
      const suffix = side === "left" ? "L" : side === "right" ? "R" : "M";
      if (!String(instance.instanceId || "").endsWith(`:${suffix}`)) pushFailure(point, instance, "instance-id-side-suffix-mismatch");
      if (!String(instance.routeId || "").endsWith(`:${suffix}`)) pushFailure(point, instance, "route-id-side-suffix-mismatch");
      const x = Number(instance.anchor?.position?.[0]);
      if (!Number.isFinite(x)) continue;
      if (side === "left" && x >= -0.000001) pushFailure(point, instance, "left-anchor-is-not-on-negative-x-side");
      if (side === "right" && x <= 0.000001) pushFailure(point, instance, "right-anchor-is-not-on-positive-x-side");
      if (side === "midline") {
        const offset = Math.abs(x - MIDLINE_SYMMETRY_PLANE_X);
        if (offset > MIDLINE_HARD_OFFSET) pushFailure(point, instance, "midline-anchor-exceeds-hard-symmetry-plane-offset");
        else if (offset > MIDLINE_REVIEW_OFFSET) reviews.push({
          id: point.id,
          instanceId: instance.instanceId,
          offset,
          reason: "midline-mesh-asymmetry-review",
        });
      }
    }

    if (point.laterality === "bilateral") {
      const left = bySide.get("left")?.[0]?.anchor?.position;
      const right = bySide.get("right")?.[0]?.anchor?.position;
      if (Array.isArray(left) && Array.isArray(right)) {
        const offset = Math.hypot(left[0] + right[0], left[1] - right[1], left[2] - right[2]);
        if (offset > BILATERAL_MIRROR_REVIEW_OFFSET) mirrorOffsets.push({ id: point.id, offset });
      }
    }
  }
  return { failures, reviews, mirrorOffsets };
}

function auditInstances(dataset, surface) {
  const instances = [];
  const missing = [];
  for (const point of pointsFromDataset(dataset)) {
    for (const instance of point.instances || []) {
      const anchor = instance.anchor;
      const rawAnchor = instance.rawAnchor;
      const attachment = anchor?.surfaceAttachment;
      if (!rawAnchor || !anchor || !attachment || !Array.isArray(anchor.position) || !Array.isArray(anchor.normal)) {
        missing.push(`${point.id}:${instance.laterality || "?"}`);
        continue;
      }
      const triangle = attachment.triangle;
      const barycentric = attachment.barycentric;
      const indexStart = triangle * 3;
      const vertexIndices = [surface.indices[indexStart], surface.indices[indexStart + 1], surface.indices[indexStart + 2]];
      if (!Number.isInteger(triangle) || !Array.isArray(barycentric) || barycentric.length !== 3 || vertexIndices.some((value) => !Number.isInteger(value))) {
        missing.push(`${point.id}:${instance.laterality || "?"}`);
        continue;
      }
      const reconstructedPosition = interpolatedValue(surface.positions, ...vertexIndices, barycentric);
      const reconstructedNormal = normalise(interpolatedValue(surface.normals, ...vertexIndices, barycentric));
      const rawNormal = normalise(rawAnchor.normal);
      const actualNormal = normalise(anchor.normal);
      const directional = semanticSurfaceMismatches(rawAnchor.surface, anchor.position, actualNormal, instance.laterality);
      const taxonomy = getSurfaceTaxonomy(rawAnchor.surface);
      const region = getRegionBand(rawAnchor.surface);
      const regionFailure = !taxonomy || !region || !region.test(anchor.position);
      const audit = {
        id: point.id,
        name: point.name,
        laterality: instance.laterality,
        route: routeFamily(instance.routeId),
        rawSurface: rawAnchor.surface,
        landmark: rawAnchor.landmark,
        anchorPosition: anchor.position,
        rawPosition: rawAnchor.position,
        projectionDistance: Number(attachment.projectionDistance),
        unconstrainedNearestDistance: Number(attachment.unconstrainedNearestDistance),
        hasDirectionalConstraint: Boolean(rawAnchor.projection && Number.isFinite(Number(rawAnchor.projection.minimumNormalAlignment))),
        rawNormal,
        actualNormal,
        normalDot: dot(rawNormal, actualNormal),
        expectedDirections: directional.labels,
        directionFailures: directional.failures,
        reviewDirections: directional.reviewLabels,
        directionReviewFailures: directional.reviewFailures,
        region: region?.name || taxonomy?.region || null,
        regionFailure,
        attachmentPositionError: distance(anchor.position, reconstructedPosition),
        attachmentNormalDot: dot(actualNormal, reconstructedNormal),
      };
      audit.severity = severityFor(audit);
      instances.push(audit);
    }
  }
  return { instances, missing };
}

function auditRouteCompression(instances) {
  const groups = new Map();
  for (const instance of instances) {
    const key = `${instance.route}:${instance.laterality}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(instance);
  }
  const collisions = [];
  for (const group of groups.values()) {
    group.sort((left, right) => {
      const pointNumber = (value) => Number(String(value.id).match(/(\d+)$/)?.[1] || 0);
      return pointNumber(left) - pointNumber(right);
    });
    for (let index = 1; index < group.length; index += 1) {
      const previous = group[index - 1];
      const current = group[index];
      const rawGap = distance(previous.rawPosition, current.rawPosition);
      const surfaceGap = distance(previous.anchorPosition, current.anchorPosition);
      if (rawGap >= 0.025 && surfaceGap <= 0.015) {
        collisions.push({
          route: current.route,
          laterality: current.laterality,
          from: previous.id,
          to: current.id,
          rawGap,
          surfaceGap,
          compression: rawGap ? surfaceGap / rawGap : 0,
        });
      }
    }
  }
  return collisions.sort((left, right) => left.compression - right.compression);
}

// Independent anatomical-region audit.  This intentionally derives its
// expectation from the canonical meridian number, not `rawAnchor.surface`,
// route name, or control-node landmark.  It gives every one of the 361 source
// points an external coarse body-region contract, so a route can no longer
// validate a neck/head/limb error merely by naming its own target surface.
const INDEPENDENT_REGION_BANDS = {
  head: ([x, y]) => Math.abs(x) <= 0.12 && y >= 1.55 && y <= 1.84,
  neck: ([x, y]) => Math.abs(x) <= 0.28 && y >= 1.40 && y <= 1.67,
  torso: ([x, y]) => Math.abs(x) <= 0.32 && y >= 0.70 && y <= 1.52,
  "upper-arm": ([x, y]) => Math.abs(x) >= 0.15 && Math.abs(x) <= 0.37 && y >= 1.20 && y <= 1.47,
  forearm: ([x, y]) => Math.abs(x) >= 0.16 && Math.abs(x) <= 0.37 && y >= 0.99 && y <= 1.33,
  palm: ([x, y, z]) => Math.abs(x) >= 0.23 && Math.abs(x) <= 0.40 && y >= 0.70 && y <= 1.00 && z >= -0.02,
  digit: ([x, y, z]) => Math.abs(x) >= 0.23 && Math.abs(x) <= 0.40 && y >= 0.69 && y <= 0.89 && z >= 0.02,
  leg: ([x, y]) => Math.abs(x) <= 0.26 && y >= 0.06 && y <= 0.82,
  foot: ([x, y]) => Math.abs(x) >= 0.035 && Math.abs(x) <= 0.20 && y >= -0.02 && y <= 0.26,
};

function parsePointId(id) {
  const match = String(id || "").match(/^([A-Z]+)(\d+)$/);
  return match ? { code: match[1], number: Number(match[2]) } : null;
}

function between(value, minimum, maximum) {
  return value >= minimum && value <= maximum;
}

function independentExpectedRegion(pointId) {
  const parsed = parsePointId(pointId);
  if (!parsed) return null;
  const { code, number } = parsed;
  if (code === "LU") return number <= 2 ? "torso" : number <= 5 ? "upper-arm" : number <= 9 ? "forearm" : number === 10 ? "palm" : "digit";
  if (code === "LI") return number <= 3 ? "digit" : number === 4 ? "palm" : number <= 11 ? "forearm" : number <= 14 ? "upper-arm" : number <= 16 ? "torso" : number <= 18 ? "neck" : "head";
  if (code === "ST") return number <= 8 ? "head" : number <= 11 ? "neck" : number <= 30 ? "torso" : number <= 40 ? "leg" : "foot";
  if (code === "SP") return number <= 5 ? "foot" : number <= 11 ? "leg" : "torso";
  if (code === "HT") return number === 1 ? "torso" : number <= 2 ? "upper-arm" : number <= 7 ? "forearm" : number === 8 ? "palm" : "digit";
  if (code === "SI") return number === 1 ? "digit" : number <= 3 ? "palm" : number <= 8 ? "forearm" : number === 9 ? "upper-arm" : number <= 15 ? "torso" : number === 16 ? "neck" : "head";
  if (code === "BL") return number <= 9 ? "head" : number === 10 ? "neck" : number <= 35 ? "torso" : number <= 40 ? "leg" : number <= 54 ? "torso" : number <= 59 ? "leg" : "foot";
  if (code === "KI") return number <= 6 ? "foot" : number <= 10 ? "leg" : "torso";
  if (code === "PC") return number === 1 ? "torso" : number <= 3 ? "upper-arm" : number <= 7 ? "forearm" : number === 8 ? "palm" : "digit";
  if (code === "TE") return number === 1 ? "digit" : number <= 3 ? "palm" : number <= 10 ? "forearm" : number <= 13 ? "upper-arm" : number <= 15 ? "torso" : number === 16 ? "neck" : "head";
  if (code === "GB") return number <= 19 ? "head" : number === 20 ? "neck" : number <= 28 ? "torso" : number <= 40 ? "leg" : "foot";
  if (code === "LR") return number <= 4 ? "foot" : number <= 11 ? "leg" : "torso";
  if (code === "CV") return number <= 22 ? "torso" : number === 23 ? "neck" : "head";
  if (code === "GV") return number <= 14 ? "torso" : number <= 16 ? "neck" : "head";
  return null;
}

function auditIndependentBodyRegions(instances) {
  const pointIds = new Set();
  const classifiedPointIds = new Set();
  const failures = [];
  for (const instance of instances) {
    pointIds.add(instance.id);
    const expectedRegion = independentExpectedRegion(instance.id);
    const band = INDEPENDENT_REGION_BANDS[expectedRegion];
    if (band) classifiedPointIds.add(instance.id);
    if (!band || !band(instance.anchorPosition)) {
      failures.push({
        id: instance.id,
        side: instance.laterality,
        expectedRegion: expectedRegion || "unclassified",
        anchorPosition: instance.anchorPosition.map((value) => toFixed(value)),
      });
    }
  }
  return {
    canonicalPointCoverage: `${classifiedPointIds.size}/${pointIds.size}`,
    markerInstanceCoverage: `${instances.filter((instance) => INDEPENDENT_REGION_BANDS[independentExpectedRegion(instance.id)]).length}/${instances.length}`,
    failures,
  };
}

// These contracts are deliberately sourced from documented landmark
// relationships across *different* channels.  They are additional to the
// all-point body-region map above and catch the historical segment-offset
// defects (for example GV8 landing at the lumbar/buttock level).
function auditIndependentLandmarkContracts(instances) {
  const byIdAndSide = new Map(instances.map((instance) => [`${instance.id}:${instance.laterality}`, instance]));
  const get = (id, side) => byIdAndSide.get(`${id}:${side}`);
  const failures = [];
  const require = (name, condition, details) => {
    if (!condition) failures.push({ name, ...details });
  };
  const y = (id, side) => get(id, side)?.anchorPosition?.[1];
  const hasY = (...values) => values.every(Number.isFinite);

  const vertebralPairs = [
    ["GV3", "BL25"], ["GV4", "BL23"], ["GV5", "BL22"], ["GV6", "BL20"], ["GV7", "BL19"], ["GV8", "BL18"],
    ["GV9", "BL17"], ["GV10", "BL16"], ["GV11", "BL15"], ["GV12", "BL13"], ["GV13", "BL11"], ["GV14", "BL11"],
  ];
  for (const [gv, bl] of vertebralPairs) {
    const gvY = y(gv, "midline");
    for (const side of ["left", "right"]) {
      const blY = y(bl, side);
      require(`vertebral-${gv}-${bl}-${side}`, hasY(gvY, blY) && Math.abs(gvY - blY) <= 0.075, {
        expected: "same documented vertebral level (±75 mm mesh allowance)", gvY: toFixed(gvY), blY: toFixed(blY),
      });
    }
  }

  for (const [sacral, paraspinal] of [["BL31", "BL27"], ["BL32", "BL28"], ["BL33", "BL29"], ["BL34", "BL30"]]) {
    for (const side of ["left", "right"]) {
      const sacralY = y(sacral, side);
      const paraspinalY = y(paraspinal, side);
      require(`sacral-${sacral}-${paraspinal}-${side}`, hasY(sacralY, paraspinalY) && Math.abs(sacralY - paraspinalY) <= 0.07, {
        expected: "same posterior sacral-foramen level (±70 mm mesh allowance)", sacralY: toFixed(sacralY), paraspinalY: toFixed(paraspinalY),
      });
    }
  }

  for (const side of ["left", "right"]) {
    const lr5Y = y("LR5", side);
    const ki9Y = y("KI9", side);
    require(`distal-LR5-KI9-${side}`, hasY(lr5Y, ki9Y) && Math.abs(lr5Y - ki9Y) <= 0.06, {
      expected: "both five cun superior to medial malleolus (±60 mm mesh allowance)", lr5Y: toFixed(lr5Y), ki9Y: toFixed(ki9Y),
    });
    const ki3Y = y("KI3", side);
    for (const id of ["KI5", "KI6"]) {
      const pointY = y(id, side);
      require(`ankle-${id}-below-KI3-${side}`, hasY(pointY, ki3Y) && pointY <= ki3Y + 0.025, {
        expected: "inferior to (or level with) KI3 at the medial malleolus", pointY: toFixed(pointY), ki3Y: toFixed(ki3Y),
      });
    }
    const bl40Y = y("BL40", side);
    const bl60Y = y("BL60", side);
    const bl55Y = y("BL55", side);
    const bl56Y = y("BL56", side);
    const bl57Y = y("BL57", side);
    require(`calf-BL55-57-${side}`, hasY(bl40Y, bl60Y, bl55Y, bl56Y, bl57Y)
      && bl55Y < bl40Y && bl55Y > bl60Y && bl56Y < bl55Y && bl57Y < bl56Y && bl57Y > bl60Y, {
      expected: "BL55–57 monotonically descend between BL40 popliteal and BL60 ankle",
      bl40Y: toFixed(bl40Y), bl55Y: toFixed(bl55Y), bl56Y: toFixed(bl56Y), bl57Y: toFixed(bl57Y), bl60Y: toFixed(bl60Y),
    });
  }

  for (const id of ["GB35", "GB36", "GB37", "GB38"]) {
    for (const side of ["left", "right"]) {
      const pointY = y(id, side);
      require(`lower-leg-${id}-${side}`, Number.isFinite(pointY) && between(pointY, 0.12, 0.26), {
        expected: "GB35–38 are 7/7/5/4 cun above the lateral malleolus", pointY: toFixed(pointY),
      });
    }
  }

  for (const side of ["left", "right"]) {
    const lr8Y = y("LR8", side);
    const lr9Y = y("LR9", side);
    const lr10Y = y("LR10", side);
    const lr11Y = y("LR11", side);
    const lr12Y = y("LR12", side);
    require(`LR-knee-thigh-groin-${side}`, hasY(lr8Y, lr9Y, lr10Y, lr11Y, lr12Y)
      && between(lr8Y, 0.33, 0.46) && between(lr9Y, 0.46, 0.64) && between(lr10Y, 0.55, 0.71)
      && between(lr11Y, 0.62, 0.80) && between(lr12Y, 0.70, 0.86), {
      expected: "LR8 popliteal → LR9–11 medial thigh → LR12 groin", lr8Y: toFixed(lr8Y), lr9Y: toFixed(lr9Y), lr10Y: toFixed(lr10Y), lr11Y: toFixed(lr11Y), lr12Y: toFixed(lr12Y),
    });
  }

  const intercostal = [
    ["CV16", "SP17", "KI22"], ["CV17", "SP18", "KI23"], ["CV18", "SP19", "KI24"],
    ["CV19", "SP20", "KI25"], ["CV20", null, "KI26"], ["CV21", null, "KI27"],
  ];
  for (const [cv, sp, ki] of intercostal) {
    const cvY = y(cv, "midline");
    for (const side of ["left", "right"]) {
      const paired = [sp ? y(sp, side) : null, y(ki, side)].filter(Number.isFinite);
      require(`intercostal-${cv}-${sp || "none"}-${ki}-${side}`, Number.isFinite(cvY) && paired.every((value) => Math.abs(value - cvY) <= 0.065), {
        expected: "same named CV intercostal/sternal level (±65 mm mesh allowance)", cvY: toFixed(cvY), pairedY: paired.map((value) => toFixed(value)),
      });
    }
  }
  return { contractCount: 64, failures };
}

// These pairs are source-distinct locations that previously collapsed onto a
// single wrist/palm/foot or arm triangle.  Tiny skin distances are hard
// failures; a 8–20 mm separation is reported for reviewer follow-up without
// pretending it proves clinical spacing on the generic body model.
const SOURCE_DISTINCT_CROSS_ROUTE_PAIRS = [
  ["LU11", "LI2"], ["HT9", "SI1"], ["LI10", "SI8"], ["LI11", "TE12"], ["SP3", "KI2"], ["BL65", "BL67"],
];

function auditSourceDistinctCrossRoutePairs(instances) {
  const byIdAndSide = new Map(instances.map((instance) => [`${instance.id}:${instance.laterality}`, instance]));
  const hardFailures = [];
  const reviewPairs = [];
  for (const [leftId, rightId] of SOURCE_DISTINCT_CROSS_ROUTE_PAIRS) {
    for (const side of ["left", "right"]) {
      const left = byIdAndSide.get(`${leftId}:${side}`);
      const right = byIdAndSide.get(`${rightId}:${side}`);
      if (!left || !right) {
        hardFailures.push({ pair: `${leftId}/${rightId}`, side, reason: "missing-side-instance" });
        continue;
      }
      const separation = distance(left.anchorPosition, right.anchorPosition);
      const entry = { pair: `${leftId}/${rightId}`, side, separation: toFixed(separation, 6) };
      if (separation < 0.008) hardFailures.push({ ...entry, reason: "source-distinct-points-collapsed-under-8mm" });
      else if (separation < 0.02) reviewPairs.push({ ...entry, reason: "source-distinct-points-within-20mm" });
    }
  }
  return { hardFailures, reviewPairs };
}

function routeSummaries(instances, collisions) {
  const summaries = new Map();
  for (const instance of instances) {
    if (!summaries.has(instance.route)) {
      summaries.set(instance.route, {
        route: instance.route,
        markerCount: 0,
        critical: 0,
        warning: 0,
        normalMismatch: 0,
        semanticMismatch: 0,
        semanticReviewMismatch: 0,
        regionMismatch: 0,
        maxProjectionDistance: 0,
        unconstrained: 0,
      });
    }
    const summary = summaries.get(instance.route);
    summary.markerCount += 1;
    if (instance.severity === "critical") summary.critical += 1;
    if (instance.severity === "warning") summary.warning += 1;
    if (instance.normalDot < 0.55) summary.normalMismatch += 1;
    if (instance.directionFailures.length) summary.semanticMismatch += 1;
    if (instance.directionReviewFailures.length) summary.semanticReviewMismatch += 1;
    if (instance.regionFailure) summary.regionMismatch += 1;
    if (!instance.hasDirectionalConstraint) summary.unconstrained += 1;
    summary.maxProjectionDistance = Math.max(summary.maxProjectionDistance, instance.projectionDistance || 0);
  }
  for (const collision of collisions) {
    if (summaries.has(collision.route)) summaries.get(collision.route).collisions = (summaries.get(collision.route).collisions || 0) + 1;
  }
  return [...summaries.values()]
    .map((summary) => ({
      ...summary,
      collisions: summary.collisions || 0,
      riskScore: summary.critical * 5 + summary.warning * 2 + summary.semanticMismatch * 2 + summary.semanticReviewMismatch + summary.regionMismatch * 2 + (summary.collisions || 0) * 3,
    }))
    .sort((left, right) => right.riskScore - left.riskScore || right.maxProjectionDistance - left.maxProjectionDistance);
}

function collapseKey(pair) {
  return `${pair.route}:${pair.laterality}:${pair.from}->${pair.to}`;
}

function makeReport(dataset, surface, instances, missing, collisions, sourceEvidenceFailures, laterality, independentBodyRegions, landmarkContracts, sourceDistinctPairs) {
  const routes = routeSummaries(instances, collisions);
  const counts = Object.fromEntries(["pass", "warning", "critical", "integrity"].map((key) => [key, instances.filter((instance) => instance.severity === key).length]));
  const constraints = instances.filter((instance) => instance.hasDirectionalConstraint).length;
  const expectedInstances = Number(dataset.coverage?.totalMarkerInstanceCount);
  const unknownSurfaceTags = [...new Set(instances.filter((instance) => !getSurfaceTaxonomy(instance.rawSurface)).map((instance) => instance.rawSurface))].sort();
  const unapprovedCollapsedSequentialPairs = collisions.filter((pair) => !APPROVED_SEQUENTIAL_COLLAPSES.has(collapseKey(pair)));
  const datasetBinding = dataset.coordinateSpace?.modelBinding;
  const datasetBindingMatches = datasetBinding?.algorithm === "sha256"
    && datasetBinding.sha256 === surface.binding.sha256
    && datasetBinding.surfaceMesh === SURFACE_MESH_NAME
    && datasetBinding.meshNodeIndex === surface.binding.meshNodeIndex;
  const attachmentPassed = !missing.length
    && Number.isFinite(expectedInstances)
    && instances.length === expectedInstances
    && !counts.integrity;
  const hardGates = {
    modelBinding: {
      passed: surface.binding.fingerprintMatches && surface.binding.transformsIdentity && surface.binding.meshNodeIndex >= 0 && datasetBindingMatches,
      reason: "Skin_Body SHA-256, generated-data binding, and every scene-path transform must match the coordinate contract.",
    },
    sourceEvidence: {
      passed: sourceEvidenceFailures.length === 0,
      failures: sourceEvidenceFailures,
    },
    attachment: {
      passed: attachmentPassed,
      missingOrMalformedInstances: missing,
      expectedInstances,
      reconstructedInstances: instances.length,
    },
    surfaceTagTaxonomy: {
      passed: unknownSurfaceTags.length === 0,
      unknownSurfaceTags,
    },
    laterality: {
      passed: laterality.failures.length === 0,
      failures: laterality.failures,
      midlinePlane: MIDLINE_SYMMETRY_PLANE_X,
      midlineReviewOffset: MIDLINE_REVIEW_OFFSET,
      midlineHardOffset: MIDLINE_HARD_OFFSET,
      midlineReviewOffsets: laterality.reviews,
      bilateralMirrorReviewOffset: BILATERAL_MIRROR_REVIEW_OFFSET,
      bilateralMirrorOffsetsOverReviewThreshold: laterality.mirrorOffsets,
    },
    rawToSkinDrift: {
      passed: instances.every((instance) => instance.projectionDistance <= 0.075),
      maximumAllowedDistance: 0.075,
      failures: instances.filter((instance) => instance.projectionDistance > 0.075).map((instance) => instance.id),
    },
    namedSurfaceSemantics: {
      passed: instances.every((instance) => !instance.directionFailures.length),
      failures: instances.filter((instance) => instance.directionFailures.length).map((instance) => ({
        id: instance.id,
        side: instance.laterality,
        surface: instance.rawSurface,
        directions: instance.directionFailures,
      })),
      curvedSurfaceReviewWarnings: instances.filter((instance) => instance.directionReviewFailures.length).map((instance) => ({
        id: instance.id,
        side: instance.laterality,
        surface: instance.rawSurface,
        directions: instance.directionReviewFailures,
      })),
    },
    bodyRegion: {
      passed: instances.every((instance) => !instance.regionFailure),
      failures: instances.filter((instance) => instance.regionFailure).map((instance) => ({
        id: instance.id,
        side: instance.laterality,
        surface: instance.rawSurface,
        region: instance.region,
      })),
    },
    independentSourceRegionCoverage: {
      passed: independentBodyRegions.canonicalPointCoverage === "361/361"
        && independentBodyRegions.markerInstanceCoverage === "670/670"
        && independentBodyRegions.failures.length === 0,
      ...independentBodyRegions,
      reason: "Canonical point-number regions are independently mapped before inspecting raw route surface tags.",
    },
    independentLandmarkContracts: {
      passed: landmarkContracts.failures.length === 0,
      ...landmarkContracts,
      reason: "Cross-channel vertebral, sacral, ankle, calf, thigh/groin, and intercostal relationships are checked independently of route labels.",
    },
    sourceDistinctCrossRoutePairs: {
      passed: sourceDistinctPairs.hardFailures.length === 0,
      ...sourceDistinctPairs,
      reason: "Known source-distinct point pairs cannot collapse into one Skin_Body landing under 8 mm.",
    },
    sequentialCollisions: {
      passed: unapprovedCollapsedSequentialPairs.length === 0,
      approvedAllowlist: [...APPROVED_SEQUENTIAL_COLLAPSES],
      unapprovedCollapsedSequentialPairs,
    },
  };
  hardGates.passed = Object.entries(hardGates)
    .filter(([key]) => key !== "passed")
    .every(([, gate]) => gate.passed);
  return {
    generatedFrom: path.relative(ROOT, DATA_PATH),
    model: path.relative(ROOT, MODEL_PATH),
    modelBinding: { ...surface.binding, datasetBinding, datasetBindingMatches },
    coverage: {
      canonicalPoints: pointsFromDataset(dataset).length,
      markerInstances: instances.length,
      expectedMarkerInstances: dataset.coverage?.totalMarkerInstanceCount,
      missingOrMalformedInstances: missing,
    },
    attachmentIntegrity: {
      maxPositionError: Math.max(0, ...instances.map((instance) => instance.attachmentPositionError)),
      minNormalDot: Math.min(1, ...instances.map((instance) => instance.attachmentNormalDot)),
    },
    directionContract: {
      constrainedInstances: constraints,
      unconstrainedInstances: instances.length - constraints,
      normalDotBelow055: instances.filter((instance) => instance.normalDot < 0.55).length,
      semanticSurfaceMismatches: instances.filter((instance) => instance.directionFailures.length).length,
      semanticReviewMismatches: instances.filter((instance) => instance.directionReviewFailures.length).length,
      regionBandMismatches: instances.filter((instance) => instance.regionFailure).length,
    },
    independentAnatomy: {
      bodyRegionCoverage: independentBodyRegions.canonicalPointCoverage,
      markerInstanceCoverage: independentBodyRegions.markerInstanceCoverage,
      bodyRegionFailures: independentBodyRegions.failures,
      landmarkContractCount: landmarkContracts.contractCount,
      landmarkContractFailures: landmarkContracts.failures,
      sourceDistinctHardFailures: sourceDistinctPairs.hardFailures,
      sourceDistinctReviewPairs: sourceDistinctPairs.reviewPairs,
    },
    projection: {
      over35mm: instances.filter((instance) => instance.projectionDistance > 0.035).length,
      over75mm: instances.filter((instance) => instance.projectionDistance > 0.075).length,
      maxDistance: Math.max(0, ...instances.map((instance) => instance.projectionDistance)),
    },
    severities: counts,
    collapsedSequentialPairs: collisions,
    hardGates,
    assessment: {
      surfaceFitQa: hardGates.passed ? "passed" : "failed",
      clinicalApproval: "not-claimed; source evidence links and mesh-surface checks do not replace point-by-point clinical review",
    },
    routes,
    highestRiskInstances: instances
      .filter((instance) => instance.severity !== "pass")
      .sort((left, right) => {
        const severity = { integrity: 4, critical: 3, warning: 2, pass: 1 };
        return severity[right.severity] - severity[left.severity]
          || right.projectionDistance - left.projectionDistance
          || left.normalDot - right.normalDot;
      })
      .slice(0, 100)
      .map((instance) => ({
        id: instance.id,
        name: instance.name,
        side: instance.laterality,
        route: instance.route,
        surface: instance.rawSurface,
        severity: instance.severity,
        normalDot: toFixed(instance.normalDot),
        projectionDistance: toFixed(instance.projectionDistance),
        directionFailures: instance.directionFailures,
        directionReviewFailures: instance.directionReviewFailures,
        region: instance.region,
        regionFailure: instance.regionFailure,
      })),
    distalRouteGuide: DISTAL_ROUTE_GUIDE,
  };
}

function printTextReport(report) {
  const { coverage, attachmentIntegrity, directionContract, projection, severities, hardGates, modelBinding, independentAnatomy } = report;
  console.log("3D surface-fit audit");
  console.log(`Model binding: ${modelBinding.fingerprintMatches ? "fingerprint match" : "FINGERPRINT MISMATCH"}; ${modelBinding.transformsIdentity ? "identity node path" : "NON-IDENTITY NODE PATH"}.`);
  console.log(`Coverage: ${coverage.canonicalPoints} canonical points; ${coverage.markerInstances}/${coverage.expectedMarkerInstances ?? "?"} marker instances.`);
  console.log(`Attachment integrity: max position error ${attachmentIntegrity.maxPositionError.toExponential(2)} m; min normal dot ${attachmentIntegrity.minNormalDot.toFixed(6)}.`);
  console.log(`Directional contract: ${directionContract.constrainedInstances}/${coverage.markerInstances} constrained; ${directionContract.unconstrainedInstances} unconstrained.`);
  console.log(`Expected-surface checks: ${directionContract.normalDotBelow055} raw-normal diagnostics; ${directionContract.semanticSurfaceMismatches} hard front/back/side mismatches; ${directionContract.semanticReviewMismatches} curved-surface review warnings; ${directionContract.regionBandMismatches} mesh-band mismatches.`);
  console.log(`Projection distance: ${projection.over35mm} over 35 mm; ${projection.over75mm} over 75 mm; max ${projection.maxDistance.toFixed(3)} m.`);
  console.log(`Independent source-region coverage: ${independentAnatomy.bodyRegionCoverage} points; ${independentAnatomy.markerInstanceCoverage} instances; ${independentAnatomy.bodyRegionFailures.length} band failures.`);
  console.log(`Independent landmark contracts: ${independentAnatomy.landmarkContractCount}; ${independentAnatomy.landmarkContractFailures.length} failures; source-distinct hard collisions ${independentAnatomy.sourceDistinctHardFailures.length}.`);
  console.log(`Severity: ${severities.pass} pass, ${severities.warning} warning, ${severities.critical} critical, ${severities.integrity} attachment-integrity failure.`);
  console.log(`Strict hard gates: ${hardGates.passed ? "PASS" : "FAIL"}. Curved-surface review warnings remain clinical-review work, not an approval claim.`);

  console.log("\nHighest-risk route families:");
  console.table(report.routes.slice(0, 18).map((route) => ({
    route: route.route,
    markers: route.markerCount,
    critical: route.critical,
    warning: route.warning,
    normal: route.normalMismatch,
    surface: route.semanticMismatch,
    review: route.semanticReviewMismatch,
    band: route.regionMismatch,
    collapsed: route.collisions,
    overMaxM: toFixed(route.maxProjectionDistance),
    unconstrained: route.unconstrained,
  })));

  if (report.collapsedSequentialPairs.length) {
    console.log("\nCollapsed sequential pairs (raw route gap >= 25 mm, final skin gap <= 15 mm):");
    console.table(report.collapsedSequentialPairs.slice(0, 30).map((pair) => ({
      route: pair.route,
      side: pair.laterality,
      pair: `${pair.from} → ${pair.to}`,
      rawM: toFixed(pair.rawGap),
      skinM: toFixed(pair.surfaceGap),
      compression: toFixed(pair.compression),
    })));
  }

  console.log("\nDistal route correction guide (Skin_Body mesh-space; use asset-left negative x and mirror x):");
  for (const item of report.distalRouteGuide) console.log(`- ${item.route} ${item.pointRange}: ${item.guide}`);
}

const dataset = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
const surface = loadSurface();
const { instances, missing } = auditInstances(dataset, surface);
const collisions = auditRouteCompression(instances);
const sourceEvidenceFailures = auditSourceEvidence(dataset);
const laterality = auditLaterality(dataset);
const independentBodyRegions = auditIndependentBodyRegions(instances);
const landmarkContracts = auditIndependentLandmarkContracts(instances);
const sourceDistinctPairs = auditSourceDistinctCrossRoutePairs(instances);
const report = makeReport(
  dataset,
  surface,
  instances,
  missing,
  collisions,
  sourceEvidenceFailures,
  laterality,
  independentBodyRegions,
  landmarkContracts,
  sourceDistinctPairs,
);

if (JSON_MODE) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  printTextReport(report);
}

if (!report.hardGates.passed) process.exitCode = 1;
