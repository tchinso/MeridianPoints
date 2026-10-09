/**
 * Source-backed localization and renderer regressions.
 * Run after rebuilding the 3D dataset: node scripts/test-acupoint-localization.mjs
 * This suite does not regenerate anchors or repeat the full surface audit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as THREE from "../assets/vendor/three/three.module.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/json/meridians.json"), "utf8"));
const dataset = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/json/acupoint-3d.json"), "utf8"));
const sourcePoints = new Map(source.meridians.flatMap((meridian) => meridian.points).map((point) => [point.id, point]));
const relationKinds = ["horizontal", "vertical", "reference"];

// Evaluate the actual browser helpers, with only the asynchronous app bootstrap
// omitted. This keeps their dependencies intact without needing a fake WebGL DOM.
const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
assert.match(appSource, /^init\(\);$/m, "App bootstrap must be isolated for the pure helper suite");
const app = vm.createContext({ document: { querySelector: () => null } });
vm.runInContext(appSource.replace(/^init\(\);$/m, ""), app, { filename: "app.js" });
const plain = (value) => JSON.parse(JSON.stringify(value));
const relatedIds = (id, kind) => dataset.points[id].localization[kind].map((relation) => relation.pointId);

test("every localization claim retains exact source evidence for its anatomical claim", () => {
  assert.equal(Object.keys(dataset.points).length, sourcePoints.size);
  let relationCount = 0;
  for (const [pointId, entry] of Object.entries(dataset.points)) {
    const localization = entry.localization;
    assert.ok(localization, `${pointId}: missing localization data`);
    assert.equal(localization.evidencePolicy, "source-text-only", pointId);
    assert.equal(localization.reviewStatus, "source-text-derived-not-clinically-reviewed", pointId);
    assert.ok(Array.isArray(localization.landmarks), `${pointId}: missing landmark list`);
    for (const kind of relationKinds) {
      assert.ok(Array.isArray(localization[kind]), `${pointId}: missing ${kind} list`);
      const seen = new Set();
      for (const relation of localization[kind]) {
        const context = `${pointId}/${kind}/${relation.pointId}`;
        assert.ok(sourcePoints.has(relation.pointId), `${context}: unknown point`);
        assert.notEqual(relation.pointId, pointId, `${context}: self relationship`);
        assert.ok(!seen.has(relation.pointId), `${context}: repeated relationship`);
        seen.add(relation.pointId);
        assert.ok(relation.label?.trim() && relation.description?.trim(), `${context}: missing explanation`);
        assert.ok(["same-side", "midline"].includes(relation.instancePolicy), `${context}: unsupported laterality`);
        const peer = sourcePoints.get(relation.pointId);
        assert.equal(relation.instancePolicy, ["CV", "GV"].includes(peer.code) ? "midline" : "same-side", context);
        assert.ok(relation.evidence?.length, `${context}: missing source evidence`);
        const evidencePointIds = new Set(relation.evidence.map((evidence) => evidence.pointId));
        assert.ok(evidencePointIds.has(pointId), `${context}: missing selected-point source evidence`);
        if (kind !== "reference") {
          assert.ok(evidencePointIds.has(relation.pointId), `${context}: missing peer source evidence`);
        }
        for (const evidence of relation.evidence) {
          assert.ok(sourcePoints.has(evidence.pointId), `${context}: unknown evidence source`);
          assert.ok(["location", "technique", "note"].includes(evidence.field), `${context}: unsupported source field`);
          const rawSource = sourcePoints.get(evidence.pointId)[evidence.field];
          assert.ok(Array.isArray(rawSource) ? rawSource.includes(evidence.text) : rawSource === evidence.text, `${context}: altered or nonexistent source text`);
        }
        relationCount += 1;
      }
    }
  }
  assert.ok(relationCount > 0, "Source-backed relationships must be available");
});

test("fifth and fourth intercostal spaces remain separate horizontal levels", () => {
  for (const peer of ["KI22", "ST18", "SP17"]) {
    assert.ok(relatedIds("CV16", "horizontal").includes(peer), `CV16 and ${peer}: fifth intercostal space`);
  }
  for (const peer of ["KI23", "ST17"]) {
    assert.ok(relatedIds("CV17", "horizontal").includes(peer), `CV17 and ${peer}: fourth intercostal space`);
    assert.ok(!relatedIds("CV16", "horizontal").includes(peer), `CV16 must not be grouped with fourth-space ${peer}`);
  }
  assert.ok(!relatedIds("CV17", "horizontal").includes("ST18"), "ST18 must not move into the fourth-space level");
  assert.ok(dataset.points.CV16.localization.horizontal.every((relation) => relation.label.includes("5")));
  assert.ok(dataset.points.CV17.localization.horizontal.every((relation) => relation.label.includes("4")));
});

test("localization uses the named source reference and a defined vertical line", () => {
  assert.ok(relatedIds("CV16", "reference").includes("CV17"), "CV16 is measured below the named CV17 reference");
  assert.ok(!relatedIds("CV16", "reference").includes("CV15"), "The old nearby CV15 display set is not a source reference");
  assert.ok(relatedIds("ST36", "reference").includes("ST35"), "ST36 source measures three cun below Dubi/ST35");
  assert.ok(relatedIds("CV16", "vertical").includes("CV17"), "The source places both on the sternal midline");
  assert.ok(!relatedIds("CV16", "vertical").includes("ST18"), "A lateral fifth-space point is not on the sternal midline");
});

test("renderer filters relation kinds, merges peers and never falls back to nearby points", () => {
  const entry = {
    nearby: ["LEGACY"],
    neighbourRelations: { learningComparisonDisplay: ["PROXIMITY"] },
    localization: {
      horizontal: [
        { pointId: "PEER", label: "제4늑간", instancePolicy: "same-side" },
        { pointId: "TARGET", label: "self", instancePolicy: "same-side" },
        { pointId: "MISSING", label: "unknown", instancePolicy: "same-side" },
        { pointId: "LEGACY", label: "invalid laterality", instancePolicy: "nearest" },
      ],
      vertical: [{ pointId: "VERTICAL", label: "흉골정중선", instancePolicy: "midline" }],
      reference: [{ pointId: "PEER", label: "취혈 기준", instancePolicy: "same-side" }],
    },
  };
  const fixture = { points: { TARGET: entry, PEER: {}, VERTICAL: {}, LEGACY: {}, PROXIMITY: {} }, comparisons: { TARGET: { nearby: ["LEGACY"] } } };
  const horizontal = plain(app.getThreeDLocalizationRelations(fixture, "TARGET", entry, new Set(["horizontal"])));
  assert.deepEqual(horizontal.map((relation) => relation.pointId), ["PEER"]);
  assert.deepEqual(horizontal[0].kinds, ["horizontal"]);
  const merged = plain(app.getThreeDLocalizationRelations(fixture, "TARGET", entry, new Set(["horizontal", "reference"])));
  assert.equal(merged.length, 1, "A peer with two roles renders once");
  assert.deepEqual(new Set(merged[0].kinds), new Set(["horizontal", "reference"]));
  assert.deepEqual(new Set(merged[0].labels), new Set(["제4늑간", "취혈 기준"]));
  assert.deepEqual(plain(app.getThreeDLocalizationRelations(fixture, "TARGET", entry, new Set())), []);
  const legacyEntry = { nearby: ["LEGACY"], neighbourRelations: { learningComparisonDisplay: ["PROXIMITY"] } };
  assert.deepEqual(plain(app.getThreeDLocalizationRelations(fixture, "TARGET", legacyEntry, new Set(relationKinds))), []);
});

test("same-side relation instances respect a selected side and midline references", () => {
  const bilateral = [{ laterality: "left" }, { laterality: "right" }];
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices(bilateral, [{ laterality: "left" }], "same-side")), [0]);
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices(bilateral, [{ laterality: "right" }], "same-side")), [1]);
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices(bilateral, bilateral, "same-side")), [0, 1]);
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices(bilateral, [{ laterality: "midline" }], "same-side")), [0, 1]);
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices([{ laterality: "right" }], [{ laterality: "left" }], "same-side")), []);
  const mixed = [...bilateral, { laterality: "midline" }];
  assert.deepEqual(plain(app.getThreeDRelationInstanceIndices(mixed, bilateral, "midline")), [2]);
});

test("medial skin normals retain their direction for marker offset and focus", () => {
  const viewer = {
    THREE,
    bounds: new THREE.Box3(new THREE.Vector3(-0.3, 0, -0.2), new THREE.Vector3(0.3, 1.8, 0.2)),
    defaultCamera: { position: new THREE.Vector3(0, 1, 3), target: new THREE.Vector3(0, 1, 0) },
  };
  const position = new THREE.Vector3(0.1, 0.9, 0);
  const medialNormal = new THREE.Vector3(-1, 0, 0);
  assert.ok(app.getThreeDExteriorNormal(viewer, position, medialNormal).dot(medialNormal) > 0.9999);
  assert.ok(app.getThreeDExteriorFocusDirection(viewer, position, medialNormal).dot(medialNormal) > 0.9999);
  assert.deepEqual(medialNormal.toArray(), [-1, 0, 0], "Resolving the normal must not mutate stored source vectors");
});

test("unbound legacy anchors preserve direct world coordinates and their configured offset", () => {
  const anchor = { position: [0.1, 0.9, 0.2], normal: [-2, 0, 0] };
  const marker = app.resolveThreeDAnchor({ THREE }, { anchor, marker: { offsetAlongNormal: 0.004 } }, { model: { markerOffset: 0.008 } });
  assert.ok(marker.position.distanceTo(new THREE.Vector3(0.096, 0.9, 0.2)) < 1e-10);
  assert.deepEqual(marker.normal.toArray(), [-1, 0, 0]);
  assert.deepEqual(anchor.position, [0.1, 0.9, 0.2]);
  assert.deepEqual(anchor.normal, [-2, 0, 0]);
});

test("rendered markers reconstruct the transformed skin attachment and apply one offset", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.setIndex([0, 1, 2]);
  const mesh = new THREE.Mesh(geometry);
  mesh.name = "Skin_Body";
  mesh.position.set(0.2, 1.1, 0.1);
  mesh.rotation.y = Math.PI / 2;
  mesh.scale.set(2, 3, 4);
  const model = new THREE.Group();
  model.add(mesh);
  model.updateMatrixWorld(true);
  const viewer = { THREE, model };
  const binding = { mesh: "Skin_Body", triangle: 0, barycentric: [0.2, 0.3, 0.5] };
  const expectedNormal = new THREE.Vector3(1, 0, 0);
  const expectedPosition = mesh.localToWorld(new THREE.Vector3(0.3, 0.5, 0)).addScaledVector(expectedNormal, 0.008);
  for (const attachment of [{ surfaceAttachment: binding }, binding]) {
    const anchor = { ...attachment, position: [99, 99, 99], normal: [0, 0, 1] };
    const marker = app.resolveThreeDAnchor(viewer, { anchor }, { model: { markerOffset: 0.008 } });
    assert.ok(marker.position.distanceTo(expectedPosition) < 1e-10, "Nested generated and flat legacy surface bindings take priority over stale direct coordinates");
    assert.ok(marker.normal.dot(expectedNormal) > 0.9999, "Surface normal follows the normal matrix");
    assert.deepEqual(anchor.position, [99, 99, 99], "Resolving the marker does not rewrite its saved anchor");
  }
  for (const barycentric of [[0.2, 0.3, 0.6], [-0.1, 0.6, 0.5], [0, 0, Number.NaN]]) {
    const anchor = { surfaceAttachment: { ...binding, barycentric }, position: [99, 99, 99], normal: [0, 0, 1] };
    assert.throws(() => app.resolveThreeDAnchor(viewer, { anchor }, { model: {} }), /barycentric coordinates are invalid/);
  }
  geometry.dispose();
});
