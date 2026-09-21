const DATA_URL = "assets/json/meridians.json";
const ACUPOINT_3D_DATA_URL = "assets/json/acupoint-3d.json";
const QUESTION_LIMITS = [10, 25, 50];
const IMAGE_PRELOAD_LOOKAHEAD = 6;
const SPECIAL_UNIT_TITLE = "요혈·오수혈·오행혈";
const SPECIAL_STUDY_PREFIX = "special-study-";
const SPECIAL_QUIZ_PREFIX = "special-quiz-";
const SPECIAL_CUMULATIVE_PREFIX = "special-cumulative-";
const PRIMARY_MERIDIAN_CODES = ["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR"];
const EXTRAORDINARY_MERIDIAN_CODES = ["CV", "GV"];
const CUMULATIVE_CODE_OVERRIDES = {
  LI: ["LI"],
  LU: ["LI", "LU"],
  ST: ["LI", "LU", "CV", "ST"],
  SP: ["LI", "LU", "CV", "ST", "SP"],
  HT: ["LI", "LU", "CV", "ST", "SP", "HT"],
  SI: ["LU", "CV", "ST", "SP", "HT", "SI"],
  BL: ["ST", "SP", "HT", "SI", "GV", "BL"],
  KI: ["SP", "HT", "SI", "GV", "BL", "KI"],
  PC: ["HT", "SI", "GV", "BL", "KI", "PC"],
  TE: ["SI", "GV", "BL", "KI", "PC", "TE"],
  GB: ["GV", "BL", "KI", "PC", "TE", "GB"],
  LR: ["LI", "LU", "CV", "ST", "SP", "HT", "SI", "GV", "BL", "KI", "PC", "TE", "GB", "LR"],
  CV: ["LI", "LU", "CV"],
  GV: ["CV", "ST", "SP", "HT", "SI", "GV"],
};

const SPECIAL_CHOICE_FALLBACKS = {
  "key-type": ["수혈", "모혈", "낙혈", "극혈"],
  "five-shu-category": ["정혈", "형혈", "수혈", "경혈", "합혈"],
  "five-phase-category": ["목혈", "화혈", "토혈", "금혈", "수혈"],
};

const app = document.querySelector("#app");
const searchButton = document.querySelector("#searchButton");
const homeButton = document.querySelector("#homeButton");
const searchSheet = document.querySelector("#searchSheet");
const searchInput = document.querySelector("#searchInput");
const searchResults = document.querySelector("#searchResults");
const modelViewerSheet = document.querySelector("#modelViewerSheet");
const modelViewerStage = document.querySelector("#modelViewerStage");
const modelViewerFallback = document.querySelector("#modelViewerFallback");
const modelViewerTitle = document.querySelector("#modelViewerTitle");
const modelViewerStatus = document.querySelector("#modelViewerStatus");
const modelViewerDetail = document.querySelector("#modelViewerDetail");
const modelViewerTarget = document.querySelector("#modelViewerTarget");
const modelViewerRetry = document.querySelector("#modelViewerRetry");
const modelViewerCloseButton = modelViewerSheet?.querySelector("button[data-close-three-d]");

let data = null;
let allPoints = [];
let meridianByCode = new Map();
let pointById = new Map();
let termGlossary = {};
let termPattern = null;
let termDefinitionSequence = 0;
let selectedMeridian = null;
let selectedSpecialUnit = false;
let studyIndex = 0;
let specialStudyIndex = 0;
let studyReturnTarget = null;
let questionLimit = 25;
let activeQuiz = null;
let feedbackTimer = null;
let imageLongPressTimer = null;
let suppressImageChoiceClick = false;
let acupoint3dData = null;
let acupoint3dDataPromise = null;
let threeDViewer = null;
let threeDViewerPoint = null;
let threeDViewerOpener = null;
let threeDViewerSession = 0;
let threeDAnimationFrame = null;
const IMAGE_LONG_PRESS_DELAY = 500;
const imagePreloadCache = new Map();

init();

async function init() {
  bindEvents();

  try {
    const response = await fetch(DATA_URL);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json();
    decorateData();
    renderHome();
  } catch (error) {
    app.innerHTML = `
      <section class="screen">
        <div class="empty-state">
          데이터를 불러오지 못했습니다. 로컬 서버에서 열어주세요.
        </div>
      </section>
    `;
    console.error(error);
  }
}

function bindEvents() {
  app.addEventListener("click", handleAppClick);
  app.addEventListener("pointerdown", handleImageChoicePointerDown);
  app.addEventListener("pointerup", clearImageLongPressTimer);
  app.addEventListener("pointercancel", clearImageLongPressTimer);
  app.addEventListener("pointerleave", clearImageLongPressTimer);
  searchButton.addEventListener("click", openSearch);
  homeButton.addEventListener("click", renderHome);
  searchInput.addEventListener("input", () => renderSearchResults(searchInput.value));
  searchResults.addEventListener("click", handleSearchResultClick);

  if (modelViewerSheet) {
    modelViewerSheet.addEventListener("click", handleThreeDViewerClick);
  }

  searchSheet.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-search]")) closeSearch();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (closeThreeDViewer()) return;
      if (closeTermDefinitions()) return;
      if (closeImagePreview()) return;
      if (!searchSheet.hidden) closeSearch();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-image-preview]")) closeImagePreview();
  });
}

/*
 * Optional local 3D data lives separately from meridians.json so anatomical
 * assets and calibrated anchors can evolve independently. Expected shape:
 * {
 *   "model": { "url": "assets/models/human-anatomy.glb", "camera": {} },
 *   "points": {
 *     "CV16": {
 *       "instances": [
 *         { "instanceId": "CV16:M", "anchor": { "position": [x, y, z], "normal": [x, y, z] } }
 *       ]
 *     }
 *   }
 * }
 * A canonical point may expose two left/right instances. The viewer renders
 * every instance in the target or curated comparison entry, so a bilateral
 * point produces two surface markers without inventing duplicate point IDs.
 * A point may include `focus: { distance, mobileDistance, target }`. An anchor
 * may instead use { mesh, triangle, barycentric } to attach a point to an
 * exact triangle on the supplied GLB surface. Rotations are radians.
 */
async function loadAcupoint3DData({ force = false } = {}) {
  if (acupoint3dData && !force) return acupoint3dData;

  if (!acupoint3dDataPromise || force) {
    acupoint3dDataPromise = fetch(ACUPOINT_3D_DATA_URL, {
      // Point anchors are generated independently of the app bundle.  Do not
      // let a long-lived browser cache keep an earlier calibration after the
      // app itself has been reloaded; this small local JSON is safe to fetch
      // fresh whenever a viewer session first opens.
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`3D data request failed: ${response.status}`);
        return response.json();
      })
      .then(normalizeAcupoint3DData)
      .then((value) => {
        acupoint3dData = value;
        return value;
      });
  }

  return acupoint3dDataPromise;
}

function normalizeAcupoint3DData(rawData) {
  if (!rawData || typeof rawData !== "object") {
    throw new Error("3D data is not an object");
  }

  const rawPoints = rawData.points || rawData.acupoints;
  const points = Array.isArray(rawPoints)
    ? Object.fromEntries(rawPoints.filter((entry) => entry?.id).map((entry) => [entry.id, entry]))
    : rawPoints;
  const rawModel = rawData.model && typeof rawData.model === "object" ? rawData.model : {};
  const modelUrl = rawModel.url || rawModel.src || rawData.modelUrl;

  if (!points || typeof points !== "object") {
    throw new Error("3D point anchors are missing");
  }

  if (typeof modelUrl !== "string" || !modelUrl.trim()) {
    throw new Error("3D model URL is missing");
  }

  return {
    ...rawData,
    model: {
      ...rawModel,
      url: modelUrl,
    },
    points,
  };
}

function handleThreeDViewerClick(event) {
  if (event.target.closest("[data-close-three-d]")) {
    closeThreeDViewer();
    return;
  }

  const button = event.target.closest("[data-three-d-action]");
  if (!button) return;

  if (button.dataset.threeDAction === "reset-camera") {
    resetThreeDView();
  }

  if (button.dataset.threeDAction === "retry" && threeDViewerPoint) {
    openThreeDViewer(threeDViewerPoint, threeDViewerOpener, {
      refreshData: true,
      reloadModel: true,
    });
  }
}

async function openThreeDViewer(point, opener = null, options = {}) {
  if (!modelViewerSheet || !modelViewerStage) return;

  const session = ++threeDViewerSession;
  threeDViewerPoint = point;
  threeDViewerOpener = opener || document.activeElement;
  modelViewerSheet.hidden = false;
  document.body.classList.add("is-three-d-open");
  modelViewerTitle.textContent = `${point.id} ${point.name} 3D 위치`;
  modelViewerTarget.textContent = `${point.id} ${point.name}의 위치를 표시합니다.`;
  setThreeDViewerState("loading", "3D 인체 모형을 불러오는 중입니다.");
  requestAnimationFrame(() => modelViewerCloseButton?.focus());

  try {
    const dataset = await loadAcupoint3DData({ force: options.refreshData });
    if (!isThreeDViewerSessionCurrent(session)) return;

    const targetEntry = getThreeDPointEntry(dataset, point.id);
    if (!targetEntry) {
      setThreeDViewerState(
        "unavailable",
        "이 혈자리의 3D 위치 데이터가 아직 준비되지 않았습니다.",
        "학습 이미지와 설명은 계속 이용할 수 있습니다.",
      );
      return;
    }

    await ensureThreeDViewer(dataset, { reloadModel: options.reloadModel });
    if (!isThreeDViewerSessionCurrent(session)) return;

    focusThreeDPoint(threeDViewer, dataset, point, targetEntry);
    setThreeDViewerState("ready", "3D 인체 모형을 표시했습니다.");
    startThreeDRenderLoop();
  } catch (error) {
    if (!isThreeDViewerSessionCurrent(session)) return;
    console.warn("Unable to open local 3D viewer", error);
    setThreeDViewerState(
      "error",
      "3D 인체 모형을 준비하지 못했습니다.",
      getThreeDViewerErrorMessage(error),
    );
  }
}

function isThreeDViewerSessionCurrent(session) {
  return !modelViewerSheet?.hidden && session === threeDViewerSession;
}

function setThreeDViewerState(state, message, detail = "") {
  if (!modelViewerStage) return;

  modelViewerStage.dataset.state = state;
  modelViewerFallback.hidden = state === "ready";
  modelViewerStatus.textContent = message;
  modelViewerDetail.textContent = detail;
  modelViewerDetail.hidden = !detail;
  modelViewerRetry.hidden = state !== "error";
}

function getThreeDViewerErrorMessage(error) {
  if (error instanceof TypeError && /fetch|import/i.test(error.message)) {
    return "로컬 3D 파일이 아직 연결되지 않았거나 불러올 수 없습니다. 파일을 확인한 뒤 다시 시도하세요.";
  }

  if (/WebGL/i.test(String(error?.message || error))) {
    return "이 기기에서 3D 그래픽을 시작할 수 없습니다. 브라우저 설정을 확인한 뒤 다시 시도하세요.";
  }

  return "3D 데이터 또는 인체 모형 파일을 확인한 뒤 다시 시도하세요.";
}

async function ensureThreeDViewer(dataset, { reloadModel = false } = {}) {
  if (!threeDViewer) {
    threeDViewer = await createThreeDViewer();
  }

  const modelKey = getThreeDModelKey(dataset.model);
  if (reloadModel || threeDViewer.modelKey !== modelKey || !threeDViewer.model) {
    await loadThreeDModel(threeDViewer, dataset);
  }

  resizeThreeDViewer();
  return threeDViewer;
}

function getThreeDModelKey(model) {
  return JSON.stringify({
    url: model.url,
    position: model.position,
    rotation: model.rotation,
    scale: model.scale,
    dracoDecoderPath: model.dracoDecoderPath,
    ktx2TranscoderPath: model.ktx2TranscoderPath,
    meshopt: model.meshopt || model.meshoptDecoder,
  });
}

async function createThreeDViewer() {
  const [THREE, gltfLoaderModule, orbitControlsModule] = await Promise.all([
    import("three"),
    import("three/addons/loaders/GLTFLoader.js"),
    import("three/addons/controls/OrbitControls.js"),
  ]);
  const { GLTFLoader } = gltfLoaderModule;
  const { OrbitControls } = orbitControlsModule;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.08;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "three-d-canvas";
  renderer.domElement.setAttribute("aria-hidden", "true");
  modelViewerStage.append(renderer.domElement);

  const nearbyLabelOverlay = createThreeDNearbyLabelOverlay();
  modelViewerStage.append(nearbyLabelOverlay.root);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x10231e);
  const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 100);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = true;
  controls.enableZoom = true;
  controls.screenSpacePanning = true;
  controls.touches.ONE = THREE.TOUCH.ROTATE;
  controls.touches.TWO = THREE.TOUCH.DOLLY_PAN;

  const hemisphereLight = new THREE.HemisphereLight(0xf0fff6, 0x12251f, 1.65);
  const keyLight = new THREE.DirectionalLight(0xfff7ee, 2.25);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.set(1024, 1024);
  keyLight.shadow.bias = -0.00015;
  const fillLight = new THREE.DirectionalLight(0xd9f0ff, 0.86);
  const rimLight = new THREE.DirectionalLight(0xb8ecd6, 1.28);
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(8, 96),
    new THREE.MeshStandardMaterial({ color: 0x0b1814, roughness: 0.92, metalness: 0 }),
  );
  ground.name = "ViewerGround";
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(hemisphereLight, keyLight, fillLight, rimLight, ground);

  const markerGroup = new THREE.Group();
  markerGroup.name = "AcupointMarkers";
  scene.add(markerGroup);

  const viewer = {
    THREE,
    GLTFLoader,
    OrbitControls,
    renderer,
    scene,
    camera,
    controls,
    hemisphereLight,
    keyLight,
    fillLight,
    rimLight,
    ground,
    markerGroup,
    nearbyLabelOverlay: nearbyLabelOverlay.root,
    nearbyLabelLeaders: nearbyLabelOverlay.leaders,
    nearbyLabels: [],
    nearbyLabelLayoutDirty: true,
    nearbyLabelLayoutSignature: "",
    model: null,
    modelKey: null,
    bounds: null,
    defaultCamera: null,
    currentPointId: null,
    resizeObserver: null,
    dracoLoader: null,
    ktx2Loader: null,
  };

  controls.addEventListener("change", () => {
    viewer.nearbyLabelLayoutDirty = true;
    renderThreeDFrame();
  });
  if (typeof ResizeObserver !== "undefined") {
    viewer.resizeObserver = new ResizeObserver(resizeThreeDViewer);
    viewer.resizeObserver.observe(modelViewerStage);
  } else {
    window.addEventListener("resize", resizeThreeDViewer, { passive: true });
  }

  return viewer;
}

function createThreeDNearbyLabelOverlay() {
  const root = document.createElement("div");
  root.className = "three-d-nearby-label-overlay";
  root.setAttribute("aria-hidden", "true");

  const leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  leaders.classList.add("three-d-nearby-leaders");
  leaders.setAttribute("focusable", "false");
  root.append(leaders);

  return { root, leaders };
}

async function loadThreeDModel(viewer, dataset) {
  clearThreeDModel(viewer);
  disposeThreeDLoaders(viewer);

  const loader = await createThreeDModelLoader(viewer, dataset.model);
  const gltf = await loader.loadAsync(dataset.model.url);
  const model = gltf.scene || gltf.scenes?.[0];
  if (!model) throw new Error("GLB scene is missing");

  applyThreeDModelTransform(viewer.THREE, model, dataset.model);
  applyDefaultThreeDLayerVisibility(model, dataset.model);
  prepareThreeDModelSurface(viewer.THREE, model);
  model.updateMatrixWorld(true);
  viewer.scene.add(model);

  const bounds = new viewer.THREE.Box3().setFromObject(model);
  if (bounds.isEmpty()) {
    viewer.scene.remove(model);
    disposeThreeDObject(model);
    throw new Error("GLB scene has no renderable bounds");
  }

  viewer.model = model;
  viewer.modelKey = getThreeDModelKey(dataset.model);
  viewer.bounds = bounds;
  configureThreeDScene(viewer, dataset);
}

async function createThreeDModelLoader(viewer, modelConfig) {
  const loader = new viewer.GLTFLoader();

  if (modelConfig.dracoDecoderPath) {
    const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
    viewer.dracoLoader = new DRACOLoader();
    viewer.dracoLoader.setDecoderPath(modelConfig.dracoDecoderPath);
    loader.setDRACOLoader(viewer.dracoLoader);
  }

  if (modelConfig.ktx2TranscoderPath) {
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
    viewer.ktx2Loader = new KTX2Loader();
    viewer.ktx2Loader.setTranscoderPath(modelConfig.ktx2TranscoderPath);
    viewer.ktx2Loader.detectSupport(viewer.renderer);
    loader.setKTX2Loader(viewer.ktx2Loader);
  }

  if (modelConfig.meshopt || modelConfig.meshoptDecoder) {
    const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
    loader.setMeshoptDecoder(MeshoptDecoder);
  }

  return loader;
}

function applyThreeDModelTransform(THREE, model, modelConfig) {
  const position = readThreeDVector3(THREE, modelConfig.position);
  const rotation = readThreeDVector3(THREE, modelConfig.rotation);
  const scaleVector = readThreeDVector3(THREE, modelConfig.scale);
  const uniformScale = Number(modelConfig.scale);

  if (position) model.position.copy(position);
  if (rotation) model.rotation.set(rotation.x, rotation.y, rotation.z);
  if (scaleVector) {
    model.scale.copy(scaleVector);
  } else if (Number.isFinite(uniformScale) && uniformScale > 0) {
    model.scale.setScalar(uniformScale);
  }
}

function applyDefaultThreeDLayerVisibility(model, modelConfig) {
  const hiddenLayers = new Set(modelConfig.hiddenLayers || ["Layer_Muscle", "Layer_Skeleton", "Layer_Landmark"]);
  const shownLayers = new Set(modelConfig.visibleLayers || []);

  model.traverse((node) => {
    if (hiddenLayers.has(node.name)) node.visible = false;
    if (shownLayers.has(node.name)) node.visible = true;
  });
}

function prepareThreeDModelSurface(THREE, model) {
  model.traverse((node) => {
    if (!node.isMesh) return;

    node.castShadow = true;
    node.receiveShadow = true;
    // Some anatomical source meshes carry faceted STL-derived normals. Rebuild
    // the continuous skin normals after loading so light reveals form rather
    // than polygon seams on a phone-sized canvas.
    node.geometry?.computeVertexNormals?.();
    node.geometry?.normalizeNormals?.();

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material?.isMeshStandardMaterial) continue;

      // Preserve authored skin textures, while avoiding a glossy, toy-like
      // appearance when a local anatomy asset uses a simple PBR material.
      material.metalness = 0;
      if (!material.map) material.roughness = Math.max(material.roughness ?? 0.58, 0.58);
      material.envMapIntensity = Math.min(material.envMapIntensity ?? 1, 0.75);
      // The teaching body is a closed exterior surface. Rendering both sides
      // creates moiré-like self-overlap on thin limbs and the face in mobile
      // WebGL, so explicitly cull the interior backfaces.
      material.side = THREE.FrontSide;
      material.needsUpdate = true;
    }
  });
}

function configureThreeDScene(viewer, dataset) {
  const { THREE, bounds, camera, controls, keyLight, hemisphereLight, fillLight, rimLight, ground } = viewer;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const largestDimension = Math.max(size.x, size.y, size.z, 0.01);
  const cameraConfig = dataset.model.camera || {};
  const configuredTarget = readThreeDVector3(THREE, cameraConfig.target);
  const configuredPosition = readThreeDVector3(THREE, cameraConfig.position);

  camera.fov = getFiniteNumber(cameraConfig.fov, 36);
  camera.near = getPositiveNumber(cameraConfig.near, Math.max(largestDimension / 1000, 0.001));
  camera.far = getPositiveNumber(cameraConfig.far, Math.max(largestDimension * 24, 100));
  controls.target.copy(configuredTarget || center);

  if (configuredPosition) {
    camera.position.copy(configuredPosition);
  } else {
    camera.position.set(center.x, center.y + size.y * 0.03, center.z + largestDimension * 1.65);
  }

  controls.minDistance = getPositiveNumber(cameraConfig.minDistance, largestDimension * 0.08);
  controls.maxDistance = getPositiveNumber(cameraConfig.maxDistance, largestDimension * 6);
  keyLight.position.set(
    bounds.max.x + largestDimension,
    bounds.max.y + largestDimension * 1.3,
    bounds.max.z + largestDimension,
  );
  fillLight.position.set(
    bounds.min.x - largestDimension * 1.2,
    center.y + largestDimension * 0.35,
    bounds.max.z + largestDimension * 0.65,
  );
  rimLight.position.set(
    bounds.max.x + largestDimension * 0.45,
    bounds.max.y + largestDimension * 0.6,
    bounds.min.z - largestDimension * 1.25,
  );
  keyLight.target.position.copy(center);
  fillLight.target.position.copy(center);
  rimLight.target.position.copy(center);
  sceneAddLightTargets(viewer.scene, keyLight, fillLight, rimLight);
  ground.position.set(center.x, bounds.min.y - largestDimension * 0.002, center.z);
  keyLight.shadow.camera.left = -largestDimension;
  keyLight.shadow.camera.right = largestDimension;
  keyLight.shadow.camera.top = largestDimension;
  keyLight.shadow.camera.bottom = -largestDimension;
  keyLight.shadow.camera.near = largestDimension * 0.05;
  keyLight.shadow.camera.far = largestDimension * 5;
  keyLight.shadow.camera.updateProjectionMatrix();
  hemisphereLight.intensity = getPositiveNumber(dataset.model.hemisphereIntensity, 1.8);
  keyLight.intensity = getPositiveNumber(dataset.model.keyLightIntensity, 2.1);
  camera.updateProjectionMatrix();
  controls.update();

  viewer.defaultCamera = {
    position: camera.position.clone(),
    target: controls.target.clone(),
    fov: camera.fov,
    focusDistance: getPositiveNumber(cameraConfig.focusDistance, largestDimension * 0.68),
  };
}

function sceneAddLightTargets(scene, ...lights) {
  for (const light of lights) {
    if (light?.target && !light.target.parent) scene.add(light.target);
  }
}

function focusThreeDPoint(viewer, dataset, point, entry) {
  const targetAnchors = resolveThreeDEntryAnchors(viewer, entry, dataset);
  if (!targetAnchors.length) throw new Error("3D anchor position is missing");

  const anchor = targetAnchors[0];
  const anchorCenter = getThreeDAnchorCenter(viewer.THREE, targetAnchors);
  const anchorNormal = getThreeDAnchorNormal(viewer.THREE, targetAnchors) || anchor.normal;
  const { THREE, camera, controls } = viewer;
  const markerRadius = getMarkerRadius(viewer, dataset, entry);

  clearThreeDMarkers(viewer);
  for (const [index, targetAnchor] of targetAnchors.entries()) {
    const markerId = targetAnchors.length > 1 ? `${point.id}:${index + 1}` : point.id;
    viewer.markerGroup.add(createThreeDMarker(viewer, targetAnchor.position, markerRadius * 1.14, 0xe63838, markerId));
  }

  const nearbyIds = getNearbyPointIds(dataset, point.id, entry);
  let nearbyCount = 0;
  for (const nearbyId of nearbyIds) {
    const nearbyEntry = getThreeDPointEntry(dataset, nearbyId);
    if (!nearbyEntry) continue;

    try {
      const nearbyAnchors = resolveThreeDEntryAnchors(viewer, nearbyEntry, dataset);
      const nearbyInstances = getThreeDEntryInstances(nearbyEntry);
      const nearbyMarkerRadius = getNearbyMarkerRadius(markerRadius);
      for (const [index, nearbyAnchor] of nearbyAnchors.entries()) {
        const markerId = nearbyAnchors.length > 1 ? `${nearbyId}:${index + 1}` : nearbyId;
        viewer.markerGroup.add(createThreeDMarker(viewer, nearbyAnchor.position, nearbyMarkerRadius, 0x060807, markerId));
        addThreeDNearbyLabel(viewer, {
          id: markerId,
          position: nearbyAnchor.position,
          normal: nearbyAnchor.normal,
          text: getThreeDNearbyLabelText(nearbyId, nearbyEntry, nearbyInstances[index], nearbyAnchors.length),
        });
        nearbyCount += 1;
      }
    } catch (error) {
      console.warn(`Skipping invalid 3D marker: ${nearbyId}`, error);
    }
  }

  const focus = getThreeDFocus(entry);
  const focusTarget = readThreeDVector3(THREE, focus.target) || anchorCenter;
  const focusPosition = readThreeDVector3(THREE, focus.cameraPosition || focus.position);
  camera.fov = getThreeDFocusFov(focus, camera.aspect, viewer.defaultCamera.fov);
  camera.updateProjectionMatrix();
  if (focusPosition) {
    camera.position.copy(focusPosition);
  } else {
    const direction = getThreeDExteriorFocusDirection(viewer, focusTarget, anchorNormal);
    const requestedDistance = getThreeDFocusDistance(focus, viewer.defaultCamera.focusDistance);
    const distance = getThreeDExteriorFocusDistance(viewer, focusTarget, direction, requestedDistance);
    camera.position.copy(focusTarget).addScaledVector(direction, distance);
  }

  controls.target.copy(focusTarget);
  controls.update();
  viewer.currentPointId = point.id;
  viewer.currentDataset = dataset;
  viewer.nearbyLabelLayoutDirty = true;
  modelViewerTarget.textContent = nearbyCount
    ? `${point.id} ${point.name} · 주변 ${nearbyCount}혈을 함께 표시합니다.`
    : `${point.id} ${point.name}을(를) 빨간 점으로 표시합니다.`;
  renderThreeDFrame();
}

function getThreeDAnchorCenter(THREE, anchors) {
  return anchors
    .reduce((center, anchor) => center.add(anchor.position), new THREE.Vector3())
    .multiplyScalar(1 / anchors.length);
}

function getThreeDAnchorNormal(THREE, anchors) {
  const normals = anchors.filter((anchor) => anchor.normal?.isVector3).map((anchor) => anchor.normal);
  if (!normals.length) return null;

  const combined = normals.reduce((sum, normal) => sum.add(normal), new THREE.Vector3());
  return combined.lengthSq() > 0.000001 ? combined.normalize() : normals[0].clone().normalize();
}

function getThreeDOutwardDirection(viewer, position) {
  if (!viewer.bounds || !position?.isVector3) return null;

  const fromModelCenter = position.clone().sub(viewer.bounds.getCenter(new viewer.THREE.Vector3()));
  return fromModelCenter.lengthSq() > 0.000001 ? fromModelCenter.normalize() : null;
}

function getThreeDExteriorNormal(viewer, position, normal) {
  if (!normal?.isVector3 || normal.lengthSq() <= 0.000001) return null;

  const exteriorNormal = normal.clone().normalize();
  const outwardDirection = getThreeDOutwardDirection(viewer, position);
  // A few triangles around the vertex have an inverted winding/normal after
  // normal smoothing.  Orient a clearly inward normal away from the model
  // centre before using it for marker offset or camera focus.
  if (outwardDirection && exteriorNormal.dot(outwardDirection) < -0.18) {
    exteriorNormal.negate();
  }
  return exteriorNormal;
}

function getThreeDExteriorFocusDirection(viewer, focusTarget, anchorNormal) {
  const fallbackDirection = viewer.defaultCamera.position.clone().sub(viewer.defaultCamera.target).normalize();
  const outwardDirection = getThreeDOutwardDirection(viewer, focusTarget);
  const surfaceDirection = getThreeDExteriorNormal(viewer, focusTarget, anchorNormal);

  if (!surfaceDirection) return outwardDirection || fallbackDirection;
  if (!outwardDirection) return surfaceDirection;

  // A tangential surface normal can still leave the initial camera inside the
  // body envelope. Blend it toward the independently derived outward vector
  // so every fallback view starts on the exterior side of the model.
  const alignment = surfaceDirection.dot(outwardDirection);
  if (alignment >= 0.22) return surfaceDirection;

  const blend = (0.22 - alignment) / (1.22 - alignment);
  return surfaceDirection.lerp(outwardDirection, blend).normalize();
}

function getThreeDExteriorFocusDistance(viewer, focusTarget, direction, requestedDistance) {
  const bounds = viewer.bounds;
  if (!bounds?.containsPoint(focusTarget)) return requestedDistance;

  const exitDistances = ["x", "y", "z"]
    .map((axis) => {
      const component = direction[axis];
      if (Math.abs(component) <= 0.000001) return null;
      const boundary = component > 0 ? bounds.max[axis] : bounds.min[axis];
      const distance = (boundary - focusTarget[axis]) / component;
      return distance >= 0 ? distance : null;
    })
    .filter((distance) => Number.isFinite(distance));

  if (!exitDistances.length) return requestedDistance;

  const largestDimension = bounds.getSize(new viewer.THREE.Vector3()).length();
  const exteriorPadding = Math.max(largestDimension * 0.06, 0.06);
  return Math.max(requestedDistance, Math.min(...exitDistances) + exteriorPadding);
}

function resolveThreeDEntryAnchors(viewer, entry, dataset) {
  const instances = getThreeDEntryInstances(entry);
  return instances.map((instance) => resolveThreeDAnchor(viewer, instance, dataset));
}

function getThreeDEntryInstances(entry) {
  const instances = Array.isArray(entry?.instances)
    ? entry.instances.filter((instance) => instance && typeof instance === "object")
    : [];
  return instances.length ? instances : [entry];
}

function resolveThreeDAnchor(viewer, entry, dataset) {
  const anchor = getThreeDAnchor(entry);
  const directPosition = readThreeDVector3(viewer.THREE, anchor.position || anchor.worldPosition);
  const directNormal = readThreeDVector3(viewer.THREE, anchor.normal);
  const hasSurfaceAttachment = Boolean(
    anchor.mesh && Number.isInteger(anchor.triangle) && Array.isArray(anchor.barycentric),
  );

  // The generated dataset carries both a convenient saved position and a
  // triangle/barycentric surface attachment.  Prefer the attachment whenever
  // it is available: it keeps every one of the 361 points on the *rendered*
  // skin after model-normal smoothing, transforms, or a future model update.
  // The saved position remains a backwards-compatible fallback for external
  // data that has not been surface-bound yet.
  if (!hasSurfaceAttachment) {
    if (!directPosition) throw new Error("3D anchor position is missing");
    const exteriorNormal = getThreeDExteriorNormal(viewer, directPosition, directNormal);
    return {
      position: applyMarkerOffset(directPosition, exteriorNormal, getMarkerOffset(entry, anchor, dataset)),
      normal: exteriorNormal,
    };
  }

  const mesh = viewer.model?.getObjectByName(anchor.mesh);
  const positionAttribute = mesh?.geometry?.getAttribute("position");
  if (!mesh?.isMesh || !positionAttribute) {
    throw new Error(`Anchor mesh is missing: ${anchor.mesh}`);
  }

  const barycentric = anchor.barycentric.map(Number);
  if (barycentric.length !== 3 || barycentric.some((value) => !Number.isFinite(value))) {
    throw new Error("Anchor barycentric coordinates are invalid");
  }

  const indices = getThreeDTriangleIndices(mesh.geometry, anchor.triangle);
  if (!indices) throw new Error("Anchor triangle is outside of mesh geometry");

  const { THREE } = viewer;
  const localPosition = new THREE.Vector3()
    .fromBufferAttribute(positionAttribute, indices[0])
    .multiplyScalar(barycentric[0])
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(positionAttribute, indices[1]), barycentric[1])
    .addScaledVector(new THREE.Vector3().fromBufferAttribute(positionAttribute, indices[2]), barycentric[2]);
  const localNormal = readThreeDVector3(THREE, anchor.normal) || getThreeDTriangleNormal(THREE, mesh, indices);
  const worldPosition = mesh.localToWorld(localPosition);
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const worldNormal = localNormal?.applyMatrix3(normalMatrix).normalize() || null;
  const exteriorNormal = getThreeDExteriorNormal(viewer, worldPosition, worldNormal);

  return {
    position: applyMarkerOffset(worldPosition, exteriorNormal, getMarkerOffset(entry, anchor, dataset)),
    normal: exteriorNormal,
  };
}

function getThreeDAnchor(entry) {
  return entry?.anchor && typeof entry.anchor === "object" ? entry.anchor : entry;
}

function getThreeDTriangleIndices(geometry, triangleIndex) {
  const start = triangleIndex * 3;
  const positionCount = geometry.getAttribute("position")?.count || 0;
  const index = geometry.getIndex();
  const indices = index
    ? [index.getX(start), index.getX(start + 1), index.getX(start + 2)]
    : [start, start + 1, start + 2];

  return indices.every((value) => Number.isInteger(value) && value >= 0 && value < positionCount)
    ? indices
    : null;
}

function getThreeDTriangleNormal(THREE, mesh, indices) {
  const normalAttribute = mesh.geometry.getAttribute("normal");
  if (normalAttribute) {
    return new THREE.Vector3()
      .fromBufferAttribute(normalAttribute, indices[0])
      .add(new THREE.Vector3().fromBufferAttribute(normalAttribute, indices[1]))
      .add(new THREE.Vector3().fromBufferAttribute(normalAttribute, indices[2]))
      .normalize();
  }

  const positionAttribute = mesh.geometry.getAttribute("position");
  if (!positionAttribute) return null;

  const first = new THREE.Vector3().fromBufferAttribute(positionAttribute, indices[0]);
  const second = new THREE.Vector3().fromBufferAttribute(positionAttribute, indices[1]);
  const third = new THREE.Vector3().fromBufferAttribute(positionAttribute, indices[2]);
  return second.sub(first).cross(third.sub(first)).normalize();
}

function applyMarkerOffset(position, normal, offset) {
  if (!normal || !Number.isFinite(offset) || offset === 0) return position;
  return position.addScaledVector(normal.clone().normalize(), offset);
}

function getMarkerOffset(entry, anchor, dataset) {
  return getFiniteNumber(
    entry?.markerOffset
      ?? entry?.marker?.offsetAlongNormal
      ?? anchor?.markerOffset
      ?? anchor?.offset
      ?? dataset?.model?.markerOffset,
    0.008,
  );
}

function getThreeDFocus(entry) {
  const anchor = getThreeDAnchor(entry);
  return entry?.focus || anchor?.focus || {};
}

function getThreeDFocusDistance(focus, fallback) {
  const defaultDistance = getPositiveNumber(focus.distance, fallback);
  // A point view should stay local on a narrow phone screen; widening the
  // camera merely because the aspect ratio is tall turns a landmark view into
  // an unhelpful full-body shot. Users can still pinch to zoom out.
  return getPositiveNumber(focus.mobileDistance, defaultDistance);
}

function getThreeDFocusFov(focus, aspect, fallback) {
  const requested = aspect < 0.8 ? focus.mobileFov ?? focus.fov : focus.fov;
  return Math.min(60, Math.max(20, getPositiveNumber(requested, fallback)));
}

function getMarkerRadius(viewer, dataset, entry) {
  const modelRadius = dataset.model.markerRadius;
  const requestedRadius = entry?.markerRadius ?? getThreeDAnchor(entry)?.markerRadius ?? modelRadius;
  const automaticRadius = Math.max(viewer.bounds.getSize(new viewer.THREE.Vector3()).length() * 0.008, 0.006);
  // Markers are intentionally kept under half the originally authored size:
  // the local anatomy remains visible on narrow mobile screens, while the
  // target still has a modest visual lead over comparison points.
  return Math.max(getPositiveNumber(requestedRadius, automaticRadius) * 0.48, 0.0038);
}

function getNearbyMarkerRadius(targetRadius) {
  // Comparison dots should remain clearly subordinate to the red target while
  // labels and leader lines carry the identifying information.
  return Math.max(targetRadius * 0.55, 0.0032);
}

function getThreeDNearbyLabelText(pointId, entry, instance, instanceCount) {
  const point = pointById.get(pointId);
  const name = entry?.name || point?.name || "";
  const laterality = instanceCount > 1 ? getThreeDLateralityLabel(instance?.laterality) : "";
  return `${pointId}${name ? ` ${name}` : ""}${laterality ? ` · ${laterality}` : ""}`;
}

function getThreeDLateralityLabel(laterality) {
  if (laterality === "left") return "좌";
  if (laterality === "right") return "우";
  return "";
}

function addThreeDNearbyLabel(viewer, label) {
  if (!viewer.nearbyLabelOverlay || !label?.position?.isVector3) return;

  const element = document.createElement("span");
  element.className = "three-d-nearby-label";
  element.dataset.markerId = label.id;
  element.textContent = label.text;
  viewer.nearbyLabelOverlay.append(element);
  viewer.nearbyLabels.push({
    ...label,
    position: label.position.clone(),
    normal: label.normal?.isVector3 ? label.normal.clone() : null,
    element,
  });
  viewer.nearbyLabelLayoutDirty = true;
}

function createThreeDMarker(viewer, position, radius, color, id) {
  const marker = new viewer.THREE.Group();
  const isNearbyMarker = color === 0x060807;

  if (isNearbyMarker) {
    const nearbySprite = createNearbyMarkerSprite(viewer, radius);
    marker.add(nearbySprite);
  } else {
    const core = new viewer.THREE.Mesh(
      new viewer.THREE.SphereGeometry(radius, 24, 18),
      new viewer.THREE.MeshBasicMaterial({ color, depthTest: true, depthWrite: false }),
    );
    core.renderOrder = 3;
    marker.add(core);
  }
  marker.name = `AcupointMarker:${id}`;
  marker.position.copy(position);
  return marker;
}

function createNearbyMarkerSprite(viewer, radius) {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f2fff8";
  context.beginPath();
  context.arc(64, 64, 54, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#060807";
  context.beginPath();
  context.arc(64, 64, 43, 0, Math.PI * 2);
  context.fill();

  const texture = new viewer.THREE.CanvasTexture(canvas);
  texture.colorSpace = viewer.THREE.SRGBColorSpace;
  const marker = new viewer.THREE.Sprite(
    new viewer.THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }),
  );
  marker.scale.setScalar(radius * 2.32);
  marker.renderOrder = 3;
  return marker;
}

function getThreeDPointEntry(dataset, pointId) {
  return dataset.points?.[pointId] || null;
}

function getNearbyPointIds(dataset, pointId, entry) {
  const anchor = getThreeDAnchor(entry);
  const comparison = dataset.comparisons?.[pointId] || {};
  const curatedIds = [
    entry?.nearby,
    entry?.related,
    anchor?.nearby,
    anchor?.related,
    comparison.nearby,
    comparison.related,
    entry?.neighbourRelations?.curatedComparisonDisplay,
  ].filter(Array.isArray).flat();
  const learningIds = entry?.neighbourRelations?.learningComparisonDisplay || [];
  const rawIds = curatedIds.length ? curatedIds : learningIds;

  return [...new Set(rawIds.map((item) => (typeof item === "string" ? item : item?.id || item?.pointId)).filter(Boolean))]
    .filter((id) => id !== pointId);
}

function clearThreeDMarkers(viewer) {
  clearThreeDNearbyLabels(viewer);
  while (viewer.markerGroup.children.length) {
    const marker = viewer.markerGroup.children[0];
    viewer.markerGroup.remove(marker);
    disposeThreeDObject(marker);
  }
}

function clearThreeDNearbyLabels(viewer) {
  if (!viewer) return;
  for (const label of viewer.nearbyLabels || []) {
    label.element?.remove();
  }
  viewer.nearbyLabels = [];
  viewer.nearbyLabelLeaders?.replaceChildren();
  viewer.nearbyLabelLayoutDirty = true;
  viewer.nearbyLabelLayoutSignature = "";
}

function clearThreeDModel(viewer) {
  clearThreeDMarkers(viewer);
  if (!viewer.model) return;

  viewer.scene.remove(viewer.model);
  disposeThreeDObject(viewer.model);
  viewer.model = null;
  viewer.modelKey = null;
  viewer.bounds = null;
  viewer.defaultCamera = null;
}

function disposeThreeDLoaders(viewer) {
  viewer.dracoLoader?.dispose();
  viewer.ktx2Loader?.dispose();
  viewer.dracoLoader = null;
  viewer.ktx2Loader = null;
}

function disposeThreeDObject(object) {
  object?.traverse?.((node) => {
    node.geometry?.dispose?.();
    const materials = Array.isArray(node.material) ? node.material : [node.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) value.dispose();
      }
      material.dispose?.();
    }
  });
}

function resizeThreeDViewer() {
  if (!threeDViewer || !modelViewerStage) return;

  const width = modelViewerStage.clientWidth;
  const height = modelViewerStage.clientHeight;
  if (!width || !height) return;

  threeDViewer.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  threeDViewer.renderer.setSize(width, height, false);
  threeDViewer.camera.aspect = width / height;
  threeDViewer.camera.updateProjectionMatrix();
  threeDViewer.nearbyLabelLayoutDirty = true;
  renderThreeDFrame();
}

function startThreeDRenderLoop() {
  stopThreeDRenderLoop();

  const render = () => {
    if (!threeDViewer || modelViewerSheet?.hidden) return;
    threeDViewer.controls.update();
    renderThreeDFrame();
    threeDAnimationFrame = requestAnimationFrame(render);
  };

  threeDAnimationFrame = requestAnimationFrame(render);
}

function stopThreeDRenderLoop() {
  if (threeDAnimationFrame) cancelAnimationFrame(threeDAnimationFrame);
  threeDAnimationFrame = null;
}

function renderThreeDFrame() {
  if (!threeDViewer) return;
  updateThreeDNearbyLabels(threeDViewer);
  threeDViewer.renderer.render(threeDViewer.scene, threeDViewer.camera);
}

function updateThreeDNearbyLabels(viewer) {
  const overlay = viewer.nearbyLabelOverlay;
  const labels = viewer.nearbyLabels;
  if (!overlay || !labels?.length || modelViewerSheet?.hidden) {
    viewer.nearbyLabelLeaders?.replaceChildren();
    return;
  }

  const width = overlay.clientWidth;
  const height = overlay.clientHeight;
  if (!width || !height) return;

  const { THREE, camera } = viewer;
  camera.updateMatrixWorld();
  const cameraPosition = camera.getWorldPosition(new THREE.Vector3());
  const cameraQuaternion = camera.getWorldQuaternion(new THREE.Quaternion());
  const layoutSignature = [
    width,
    height,
    Math.round(cameraPosition.x * 1000),
    Math.round(cameraPosition.y * 1000),
    Math.round(cameraPosition.z * 1000),
    Math.round(cameraQuaternion.x * 10000),
    Math.round(cameraQuaternion.y * 10000),
    Math.round(cameraQuaternion.z * 10000),
    Math.round(cameraQuaternion.w * 10000),
  ].join(":");
  if (!viewer.nearbyLabelLayoutDirty && viewer.nearbyLabelLayoutSignature === layoutSignature) return;

  viewer.nearbyLabelLayoutDirty = false;
  viewer.nearbyLabelLayoutSignature = layoutSignature;
  viewer.nearbyLabelLeaders.replaceChildren();
  viewer.nearbyLabelLeaders.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const candidates = [];
  for (const label of labels) {
    const projected = label.position.clone().project(camera);
    const screenX = (projected.x * 0.5 + 0.5) * width;
    const screenY = (-projected.y * 0.5 + 0.5) * height;
    const isInView = projected.z >= -1 && projected.z <= 1 && screenX >= 0 && screenX <= width && screenY >= 0 && screenY <= height;
    const isFacingCamera = !label.normal || label.normal.dot(cameraPosition.clone().sub(label.position).normalize()) > 0.035;

    if (!isInView || !isFacingCamera) {
      label.element.classList.remove("is-visible");
      continue;
    }

    candidates.push({
      ...label,
      screenX,
      screenY,
      width: label.element.offsetWidth,
      height: label.element.offsetHeight,
    });
  }

  const markerPositions = candidates.map(({ screenX, screenY }) => ({ x: screenX, y: screenY }));
  const occupied = [];
  for (const candidate of candidates.sort((a, b) => a.screenY - b.screenY || a.screenX - b.screenX)) {
    const placement = placeThreeDNearbyLabel(candidate, occupied, markerPositions, width, height);
    candidate.element.style.left = `${Math.round(placement.x)}px`;
    candidate.element.style.top = `${Math.round(placement.y)}px`;
    candidate.element.classList.add("is-visible");
    occupied.push(placement);
    addThreeDNearbyLeader(viewer.nearbyLabelLeaders, candidate, placement);
  }
}

function placeThreeDNearbyLabel(candidate, occupied, markerPositions, stageWidth, stageHeight) {
  const padding = 7;
  const gap = 12;
  const verticalOffsets = [0, -24, 24, -48, 48, -72, 72, -96, 96];
  const outwardDirection = candidate.screenX < stageWidth / 2 ? "left" : "right";
  const directions = [outwardDirection, outwardDirection === "left" ? "right" : "left"];
  let bestPlacement = null;

  for (const direction of directions) {
    for (const verticalOffset of verticalOffsets) {
      const unclampedX = direction === "right"
        ? candidate.screenX + gap
        : candidate.screenX - gap - candidate.width;
      const x = clampThreeDLabelValue(unclampedX, padding, Math.max(padding, stageWidth - candidate.width - padding));
      const y = clampThreeDLabelValue(
        candidate.screenY - candidate.height / 2 + verticalOffset,
        padding,
        Math.max(padding, stageHeight - candidate.height - padding),
      );
      const placement = { x, y, width: candidate.width, height: candidate.height };
      const collision = getThreeDLabelCollisionScore(placement, occupied, markerPositions, candidate);
      const travel = Math.abs(x - unclampedX) + Math.abs(verticalOffset) * 0.18;
      const score = collision + travel;

      if (collision === 0) return placement;
      if (!bestPlacement || score < bestPlacement.score) bestPlacement = { ...placement, score };
    }
  }

  return bestPlacement || { x: padding, y: padding, width: candidate.width, height: candidate.height };
}

function getThreeDLabelCollisionScore(placement, occupied, markerPositions, candidate) {
  let score = 0;
  for (const existing of occupied) {
    score += getThreeDRectOverlapArea(placement, existing) * 5;
  }

  for (const marker of markerPositions) {
    const isOwnMarker = Math.abs(marker.x - candidate.screenX) < 0.1 && Math.abs(marker.y - candidate.screenY) < 0.1;
    if (!isOwnMarker && isThreeDPointInsideRect(marker, placement, 5)) score += 600;
  }
  return score;
}

function getThreeDRectOverlapArea(first, second) {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function isThreeDPointInsideRect(point, rect, padding = 0) {
  return point.x >= rect.x - padding
    && point.x <= rect.x + rect.width + padding
    && point.y >= rect.y - padding
    && point.y <= rect.y + rect.height + padding;
}

function clampThreeDLabelValue(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function addThreeDNearbyLeader(svg, candidate, placement) {
  if (!svg) return;
  const endX = candidate.screenX <= placement.x
    ? placement.x
    : candidate.screenX >= placement.x + placement.width
      ? placement.x + placement.width
      : clampThreeDLabelValue(candidate.screenX, placement.x + 5, placement.x + placement.width - 5);
  const endY = clampThreeDLabelValue(candidate.screenY, placement.y + 5, placement.y + placement.height - 5);
  const bendX = candidate.screenX + (endX - candidate.screenX) * 0.5;
  const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  line.classList.add("three-d-nearby-leader");
  line.setAttribute("points", `${candidate.screenX},${candidate.screenY} ${bendX},${candidate.screenY} ${endX},${endY}`);
  svg.append(line);
}

function resetThreeDView() {
  if (!threeDViewer || !threeDViewerPoint || !threeDViewer.currentDataset) return;

  const entry = getThreeDPointEntry(threeDViewer.currentDataset, threeDViewerPoint.id);
  if (!entry) return;

  try {
    focusThreeDPoint(threeDViewer, threeDViewer.currentDataset, threeDViewerPoint, entry);
  } catch (error) {
    console.warn("Unable to reset 3D view", error);
  }
}

function closeThreeDViewer() {
  if (!modelViewerSheet || modelViewerSheet.hidden) return false;

  threeDViewerSession += 1;
  modelViewerSheet.hidden = true;
  document.body.classList.remove("is-three-d-open");
  stopThreeDRenderLoop();

  const opener = threeDViewerOpener;
  threeDViewerOpener = null;
  if (opener instanceof HTMLElement && opener.isConnected) {
    requestAnimationFrame(() => opener.focus());
  }

  return true;
}

function readThreeDVector3(THREE, value) {
  if (Array.isArray(value) && value.length >= 3) {
    const [x, y, z] = value.slice(0, 3).map(Number);
    return [x, y, z].every(Number.isFinite) ? new THREE.Vector3(x, y, z) : null;
  }

  if (value && typeof value === "object") {
    const x = Number(value.x);
    const y = Number(value.y);
    const z = Number(value.z);
    return [x, y, z].every(Number.isFinite) ? new THREE.Vector3(x, y, z) : null;
  }

  return null;
}

function getFiniteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getPositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function decorateData() {
  meridianByCode = new Map();
  pointById = new Map();
  termGlossary = data.termGlossary || {};

  const terms = Object.keys(termGlossary).sort((a, b) => b.length - a.length);
  termPattern = terms.length
    ? new RegExp(`(${terms.map(escapeRegularExpression).join("|")})`, "g")
    : null;

  for (const meridian of data.meridians) {
    meridianByCode.set(meridian.code, meridian);
    for (const point of meridian.points) {
      point.meridianName = meridian.name;
      point.meridianOrder = meridian.order;
      pointById.set(point.id, point);
    }
  }

  allPoints = data.meridians.flatMap((meridian) => meridian.points);
}

function handleAppClick(event) {
  if (suppressImageChoiceClick && event.target.closest(".image-choice")) {
    event.preventDefault();
    suppressImageChoiceClick = false;
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) {
    closeTermDefinitions();
    return;
  }

  const action = button.dataset.action;
  const code = button.dataset.code;
  const menu = button.dataset.menu;
  const id = button.dataset.id;

  if (action === "toggle-term-definition") {
    toggleTermDefinition(button);
    return;
  }

  if (action === "select-meridian") {
    studyReturnTarget = null;
    selectedSpecialUnit = false;
    selectedMeridian = meridianByCode.get(code);
    renderMenu();
  }

  if (action === "select-special-unit") {
    studyReturnTarget = null;
    selectedSpecialUnit = true;
    selectedMeridian = null;
    renderSpecialMenu();
  }

  if (action === "open-point") {
    const point = pointById.get(id);
    if (point) {
      startStudy(point.code, point.id, {
        returnTarget: {
          type: "special-study",
          index: specialStudyIndex,
        },
      });
    }
  }

  if (action === "open-3d-view") {
    const point = pointById.get(id);
    if (point) openThreeDViewer(point, button);
    return;
  }

  if (action === "back-home") renderHome();
  if (action === "back-special-study") returnToSpecialStudy();
  if (action === "back-menu") {
    if (selectedSpecialUnit) {
      renderSpecialMenu();
    } else {
      renderMenu();
    }
  }

  if (action === "set-limit") {
    questionLimit = Number(button.dataset.count);
    if (button.dataset.scope === "special-study") {
      renderSpecialStudy();
    } else if (selectedSpecialUnit) {
      renderSpecialMenu();
    } else {
      renderMenu();
    }
  }

  if (action === "start-menu") {
    if (menu === "study") {
      startStudy(selectedMeridian.code);
    } else if (menu === "special-study") {
      startSpecialStudy();
    } else if (menu.startsWith(SPECIAL_STUDY_PREFIX)) {
      startSpecialStudyByMenu(menu);
    } else {
      startQuiz(menu);
    }
  }

  if (action === "study-prev") {
    studyIndex = Math.max(0, studyIndex - 1);
    renderStudy();
  }

  if (action === "study-next") {
    studyIndex = Math.min(selectedMeridian.points.length - 1, studyIndex + 1);
    renderStudy();
  }

  if (action === "special-study-prev") {
    specialStudyIndex = Math.max(0, specialStudyIndex - 1);
    renderSpecialStudy();
  }

  if (action === "special-study-next") {
    specialStudyIndex = Math.min(getImportantLessons().length - 1, specialStudyIndex + 1);
    renderSpecialStudy();
  }

  if (action === "answer") handleAnswer(id);
  if (action === "retry") startQuiz(activeQuiz.menuId);
}

function clearFeedbackTimer() {
  if (feedbackTimer) {
    clearTimeout(feedbackTimer);
    feedbackTimer = null;
  }
}

function renderHome() {
  clearFeedbackTimer();
  activeQuiz = null;
  selectedMeridian = null;
  selectedSpecialUnit = false;
  studyReturnTarget = null;

  app.innerHTML = `
    <section class="screen">
      <div class="screen-heading">
        <p class="kicker">${data.meridians.length + (hasSpecialUnit() ? 1 : 0)}개 단원</p>
        <h2>단원을 고르세요</h2>
      </div>
      <div class="unit-grid">
        ${renderHomeUnitCards()}
      </div>
    </section>
  `;
}

function renderHomeUnitCards() {
  const cards = [];
  const primaryMeridians = getMeridiansByCodes(PRIMARY_MERIDIAN_CODES);
  const extraordinaryMeridians = getMeridiansByCodes(EXTRAORDINARY_MERIDIAN_CODES);

  cards.push(renderUnitSection("12경맥", primaryMeridians));
  cards.push(renderUnitSection("기경팔맥", extraordinaryMeridians));

  if (hasSpecialUnit()) {
    cards.push(`
      <button class="unit-card special-unit-card" type="button" data-action="select-special-unit">
        <strong>${SPECIAL_UNIT_TITLE}</strong>
        <span>${getImportantLessons().length}개 묶음</span>
      </button>
    `);
  }

  return cards.join("");
}

function getMeridiansByCodes(codes) {
  return codes.map((code) => meridianByCode.get(code)).filter(Boolean);
}

function renderUnitSection(title, meridians) {
  if (!meridians.length) return "";

  return `
    <div class="unit-section-title">${escapeHtml(title)}</div>
    ${meridians.map(renderUnitCard).join("")}
  `;
}

function renderUnitCard(meridian) {
  return `
    <button class="unit-card" type="button" data-action="select-meridian" data-code="${escapeHtml(meridian.code)}">
      <strong>${escapeHtml(meridian.name)}</strong>
      <span>${meridian.points.length}혈</span>
    </button>
  `;
}

function hasSpecialUnit() {
  return getImportantLessons().length > 0;
}

function getImportantLessons() {
  return data?.important?.lessons || [];
}

function renderMenu() {
  clearFeedbackTimer();
  activeQuiz = null;
  if (!selectedMeridian) {
    renderHome();
    return;
  }

  app.innerHTML = `
    <section class="screen">
      <div class="study-top">
        <button class="text-button secondary" type="button" data-action="back-home">단원</button>
        <span class="progress-pill">${selectedMeridian.points.length}혈</span>
        <span></span>
      </div>

      <div class="screen-heading">
        <p class="kicker">선택 단원</p>
        <h2>${escapeHtml(selectedMeridian.name)}</h2>
      </div>

      <div class="segment" aria-label="문제 수">
        <span class="segment-label">문제 수</span>
        <div class="segment-buttons">
          ${QUESTION_LIMITS.map(
            (count) => `
              <button
                class="segment-button ${questionLimit === count ? "is-active" : ""}"
                type="button"
                data-action="set-limit"
                data-count="${count}"
              >
                ${count}문제
              </button>
            `,
          ).join("")}
        </div>
      </div>

      <div class="menu-list">
        ${menuCard("study", "학습(순서대로)", "이미지, 위치, 취혈요령")}
        ${menuCard("image-name-ordered", "위치→이름 (순서대로)", "전체 경혈")}
        ${menuCard("image-name-random", "위치→이름 (무작위)", `${questionLimit}문제`)}
        ${menuCard("name-image-random", "이름→위치", `${questionLimit}문제`)}
        ${menuCard("image-name-cumulative", "위치→이름 (이전단원 포함)", `${questionLimit}문제`)}
        ${menuCard("name-image-cumulative", "이름→위치 (이전단원 포함)", `${questionLimit}문제`)}
      </div>
    </section>
  `;
}

function renderSpecialMenu() {
  clearFeedbackTimer();
  activeQuiz = null;
  selectedSpecialUnit = true;

  const lessons = getImportantLessons();
  if (!lessons.length) {
    renderHome();
    return;
  }

  app.innerHTML = `
    <section class="screen">
      <div class="study-top">
        <button class="text-button secondary" type="button" data-action="back-home">단원</button>
        <span class="progress-pill">${lessons.length}묶음</span>
        <span></span>
      </div>

      <div class="screen-heading">
        <p class="kicker">선택 단원</p>
        <h2>${SPECIAL_UNIT_TITLE}</h2>
      </div>

      <div class="menu-list">
        ${renderSpecialLessonCards(lessons)}
      </div>
    </section>
  `;
}

function renderSpecialLessonCards(lessons) {
  return lessons
    .map((lesson) => menuCard(`${SPECIAL_STUDY_PREFIX}${lesson.id}`, lesson.title, lesson.intro || "소단원 학습"))
    .join("");
}

function renderQuestionLimitSegment(scope = "") {
  const scopeAttribute = scope ? ` data-scope="${escapeHtml(scope)}"` : "";

  return `
    <div class="segment" aria-label="문제 수">
      <span class="segment-label">문제 수</span>
      <div class="segment-buttons">
        ${QUESTION_LIMITS.map(
          (count) => `
            <button
              class="segment-button ${questionLimit === count ? "is-active" : ""}"
              type="button"
              data-action="set-limit"
              data-count="${count}"
              ${scopeAttribute}
            >
              ${count}문제
            </button>
          `,
        ).join("")}
      </div>
    </div>
  `;
}

function menuCard(id, title, detail) {
  return `
    <button class="menu-card" type="button" data-action="start-menu" data-menu="${id}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </button>
  `;
}

function startStudy(code, pointId = null, options = {}) {
  clearFeedbackTimer();
  activeQuiz = null;
  selectedSpecialUnit = false;
  studyReturnTarget = options.returnTarget || null;
  selectedMeridian = meridianByCode.get(code);
  studyIndex = pointId
    ? Math.max(0, selectedMeridian.points.findIndex((point) => point.id === pointId))
    : 0;
  renderStudy();
}

function renderStudy() {
  if (!selectedMeridian) {
    renderHome();
    return;
  }

  const point = selectedMeridian.points[studyIndex];
  app.innerHTML = `
    <section class="screen">
      <div class="study-top">
        ${renderStudyBackButton()}
        <button class="study-nav-button" type="button" data-action="study-prev" ${studyIndex === 0 ? "disabled" : ""}>이전</button>
        <span class="progress-pill">${studyIndex + 1} / ${selectedMeridian.points.length}</span>
        <button class="study-nav-button" type="button" data-action="study-next" ${studyIndex === selectedMeridian.points.length - 1 ? "disabled" : ""}>다음</button>
      </div>

      <div class="point-title">
        <p class="kicker">${escapeHtml(selectedMeridian.name)}</p>
        <h2>${renderStudyPointName(point)}</h2>
        ${renderPointAliases(point)}
      </div>

      <figure class="image-panel">
        <img src="${escapeHtml(point.image)}" alt="${escapeHtml(point.name)} 위치 이미지" />
        <button
          class="three-d-open-button"
          type="button"
          data-action="open-3d-view"
          data-id="${escapeHtml(point.id)}"
          aria-haspopup="dialog"
          aria-label="3D로 보기"
        >3D</button>
      </figure>

      ${infoBlock("위치", point.location)}
      ${infoBlock("취혈요령", point.technique)}
      ${shouldShowMeridianImportantTip() ? renderMeridianImportantTip(selectedMeridian) : ""}
    </section>
  `;

  preloadUpcomingStudyImages(studyIndex + 1);
}

function shouldShowMeridianImportantTip() {
  if (!isRegularMeridianStudy()) return false;

  const point = selectedMeridian.points[studyIndex];
  return (
    studyIndex === 0
    || studyIndex === selectedMeridian.points.length - 1
    || Boolean(getFivePhaseItem(selectedMeridian, point))
  );
}

function isRegularMeridianStudy() {
  return (
    PRIMARY_MERIDIAN_CODES.includes(selectedMeridian?.code)
    && studyReturnTarget?.type !== "special-study"
  );
}

function renderStudyPointName(point) {
  const pointName = escapeHtml(point.name);
  const isRegularStudy = isRegularMeridianStudy();
  const keyType = shouldShowPointRoleMarker(point)
    ? getPointKeyType(selectedMeridian, point)
    : "";
  const roleMarker = keyType === "낙혈" ? "낙" : keyType === "극혈" ? "극" : "";
  const fivePhase = isRegularStudy ? getFivePhaseItem(selectedMeridian, point) : null;
  const phaseLabel = fivePhase?.category?.replace(/혈$/, "") || "";

  const roleClass = roleMarker === "낙" ? "is-luo" : "is-xi";
  const phaseClass = {
    목: "is-wood",
    화: "is-fire",
    토: "is-earth",
    금: "is-metal",
    수: "is-water",
  }[phaseLabel] || "";
  const rolePrefix = roleMarker
    ? `<span class="point-role-marker ${roleClass}">${roleMarker}</span> `
    : "";
  const phaseBadge = phaseLabel
    ? `<span class="five-phase-badge ${phaseClass}">${escapeHtml(phaseLabel)}</span>`
    : "";

  return `${rolePrefix}${pointName}${phaseBadge}`;
}

function shouldShowPointRoleMarker(point) {
  if (studyReturnTarget?.type === "special-study") return false;

  return (
    PRIMARY_MERIDIAN_CODES.includes(selectedMeridian?.code)
    || point?.id === "CV15"
    || point?.id === "GV1"
  );
}

function getPointKeyType(meridian, point) {
  const keyPoint = data.important?.keyPoints?.find((entry) => entry.code === meridian?.code);
  return keyPoint?.items?.find(
    (item) => item.pointId === point?.id && (item.type === "낙혈" || item.type === "극혈"),
  )?.type;
}

function getFivePhaseItem(meridian, point) {
  const five = data.important?.fiveShuAndFivePhase?.find((entry) => entry.code === meridian?.code);
  return five?.fivePhase?.find((item) => item.pointId === point?.id);
}

function renderStudyBackButton() {
  if (studyReturnTarget?.type === "special-study") {
    return `<button class="text-button secondary return-button" type="button" data-action="back-special-study">요혈 학습</button>`;
  }

  return `<button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>`;
}

function returnToSpecialStudy() {
  const targetIndex = studyReturnTarget?.type === "special-study" ? studyReturnTarget.index : specialStudyIndex;
  studyReturnTarget = null;
  startSpecialStudy(targetIndex);
}

function renderPointAliases(point) {
  if (!point.aliases?.length) return "";
  return `<p class="point-aliases">별칭: ${escapeHtml(point.aliases.join(", "))}</p>`;
}

function renderMeridianImportantTip(meridian) {
  const keyPoint = data.important?.keyPoints?.find((entry) => entry.code === meridian.code);
  const five = data.important?.fiveShuAndFivePhase?.find((entry) => entry.code === meridian.code);
  const rows = [];

  if (keyPoint?.items?.length) {
    rows.push(`<p><strong>요혈</strong> ${keyPoint.items.map(formatImportantTipItem).join(" / ")}</p>`);
  }

  if (five?.fiveShu?.length) {
    rows.push(`<p><strong>오수혈</strong> ${five.fiveShu.map(formatCategoryTipItem).join(" / ")}</p>`);
  }

  if (five?.fivePhase?.length) {
    rows.push(`<p><strong>오행혈</strong> ${five.fivePhase.map(formatCategoryTipItem).join(" / ")}</p>`);
  }

  if (!rows.length) return "";

  return `
    <section class="tip-block">
      <h3>${SPECIAL_UNIT_TITLE} 팁</h3>
      ${rows.join("")}
    </section>
  `;
}

function formatImportantTipItem(item) {
  const related = item.relatedMeridian && (item.pointCode === "CV" || item.pointCode === "GV")
    ? `${item.relatedMeridian} `
    : "";
  return `${related}${item.type} ${formatPointName(item)}`;
}

function formatCategoryTipItem(item) {
  return `${formatPointName(item)}(${item.category})`;
}

function formatPointName(item) {
  return item.pointId ? `${item.pointName} ${item.pointId}` : item.pointName;
}

function infoBlock(title, items) {
  const list = items.length
    ? items.map((item) => `<li>${renderGlossaryText(item)}</li>`).join("")
    : `<li>등록된 내용 없음</li>`;

  return `
    <section class="info-block">
      <h3>${escapeHtml(title)}</h3>
      <ul class="info-list">${list}</ul>
    </section>
  `;
}

function renderGlossaryText(text) {
  if (!termPattern) return escapeHtml(text);

  return text.split(termPattern).map((part) => {
    const definition = termGlossary[part];
    return definition ? renderTermDefinition(part, definition) : escapeHtml(part);
  }).join("");
}

function renderTermDefinition(term, definition) {
  const definitionId = `term-definition-${++termDefinitionSequence}`;

  return `
    <button
      class="term-definition-trigger"
      type="button"
      data-action="toggle-term-definition"
      aria-label="${escapeHtml(term)}"
      aria-describedby="${definitionId}"
      aria-expanded="false"
    >
      ${escapeHtml(term)}
      <span class="term-definition" id="${definitionId}" role="tooltip" hidden>${escapeHtml(definition)}</span>
    </button>
  `;
}

function toggleTermDefinition(button) {
  const isOpen = button.getAttribute("aria-expanded") === "true";
  closeTermDefinitions();

  if (!isOpen) {
    button.setAttribute("aria-expanded", "true");
    button.querySelector(".term-definition").hidden = false;
  }
}

function closeTermDefinitions() {
  const openTriggers = [...app.querySelectorAll('.term-definition-trigger[aria-expanded="true"]')];

  for (const trigger of openTriggers) {
    trigger.setAttribute("aria-expanded", "false");
    trigger.querySelector(".term-definition").hidden = true;
  }

  return openTriggers.length > 0;
}

function escapeRegularExpression(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function startSpecialStudy(index = 0) {
  clearFeedbackTimer();
  activeQuiz = null;
  studyReturnTarget = null;
  selectedSpecialUnit = true;
  selectedMeridian = null;
  specialStudyIndex = Math.max(0, Math.min(index, getImportantLessons().length - 1));
  renderSpecialStudy();
}

function startSpecialStudyByMenu(menuId) {
  const lessonId = menuId.replace(SPECIAL_STUDY_PREFIX, "");
  const lessonIndex = getImportantLessons().findIndex((lesson) => lesson.id === lessonId);

  if (lessonIndex < 0) {
    renderSpecialMenu();
    return;
  }

  startSpecialStudy(lessonIndex);
}

function renderSpecialStudy() {
  const lessons = getImportantLessons();
  const lesson = lessons[specialStudyIndex];

  if (!lesson) {
    renderSpecialMenu();
    return;
  }

  app.innerHTML = `
    <section class="screen">
      <div class="study-top">
        <button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>
        <button class="study-nav-button" type="button" data-action="special-study-prev" ${specialStudyIndex === 0 ? "disabled" : ""}>이전</button>
        <span class="progress-pill">${specialStudyIndex + 1} / ${lessons.length}</span>
        <button class="study-nav-button" type="button" data-action="special-study-next" ${specialStudyIndex === lessons.length - 1 ? "disabled" : ""}>다음</button>
      </div>

      <div class="screen-heading">
        <p class="kicker">${SPECIAL_UNIT_TITLE}</p>
        <h2>${escapeHtml(lesson.title)}</h2>
        <p class="lesson-intro">${escapeHtml(lesson.intro)}</p>
      </div>

      ${renderSpecialLessonRows(lesson)}

      ${renderQuestionLimitSegment("special-study")}

      <div class="lesson-actions">
        <button class="result-action secondary" type="button" data-action="start-menu" data-menu="${SPECIAL_QUIZ_PREFIX}${escapeHtml(lesson.id)}">이 묶음 퀴즈</button>
        <button class="result-action" type="button" data-action="start-menu" data-menu="${SPECIAL_CUMULATIVE_PREFIX}${escapeHtml(lesson.id)}">누적 퀴즈</button>
      </div>
    </section>
  `;
}

function renderSpecialLessonRows(lesson) {
  return lesson.rows
    .map(
      (row) => `
        <section class="info-block lesson-row">
          <h3>${escapeHtml(row.label)}</h3>
          <dl class="fact-list">
            ${row.values
              .map(
                (value) => `
                  <div class="fact-item">
                    <dt>${escapeHtml(value.label)}</dt>
                    <dd>
                      ${renderSpecialPointValue(value)}
                      ${value.detail ? `<span>${escapeHtml(value.detail)}</span>` : ""}
                    </dd>
                  </div>
                `,
              )
              .join("")}
          </dl>
        </section>
      `,
    )
    .join("");
}

function renderSpecialPointValue(value) {
  if (!value.pointId) {
    return `<strong>${escapeHtml(value.value)}</strong>`;
  }

  return `
    <button
      class="point-link"
      type="button"
      data-action="open-point"
      data-id="${escapeHtml(value.pointId)}"
    >
      ${escapeHtml(value.value)}
    </button>
  `;
}

function startQuiz(menuId) {
  clearFeedbackTimer();
  const config = createQuizConfig(menuId);
  if (!config) return;
  activeQuiz = {
    ...config,
    menuId,
    questions: config.kind === "special" ? buildSpecialQuestions(config) : buildQuestions(config),
    index: 0,
    correct: 0,
    wrong: [],
    locked: false,
    feedback: null,
  };

  renderQuiz();
}

function getCumulativeMeridians(meridian) {
  const overrideCodes = CUMULATIVE_CODE_OVERRIDES[meridian.code];
  if (overrideCodes) return getMeridiansByCodes(overrideCodes);

  return data.meridians.filter((candidate) => (
    PRIMARY_MERIDIAN_CODES.includes(candidate.code)
    && candidate.order <= meridian.order
  ));
}

function createQuizConfig(menuId) {
  if (menuId.startsWith(SPECIAL_QUIZ_PREFIX) || menuId.startsWith(SPECIAL_CUMULATIVE_PREFIX)) {
    return createSpecialQuizConfig(menuId);
  }

  if (!selectedMeridian) return null;

  const unitPoints = selectedMeridian.points;
  const cumulativePoints = getCumulativeMeridians(selectedMeridian).flatMap((meridian) => meridian.points);

  const configs = {
    "image-name-ordered": {
      title: "위치→이름 (순서대로)",
      promptType: "image",
      choiceType: "name",
      questionPool: unitPoints,
      optionScope: allPoints,
      ordered: true,
      count: unitPoints.length,
      sameChoices: 3,
      otherChoices: 2,
    },
    "image-name-random": {
      title: "위치→이름 (무작위)",
      promptType: "image",
      choiceType: "name",
      questionPool: unitPoints,
      optionScope: allPoints,
      ordered: false,
      count: questionLimit,
      sameChoices: 3,
      otherChoices: 2,
    },
    "name-image-random": {
      title: "이름→위치",
      promptType: "name",
      choiceType: "image",
      questionPool: unitPoints,
      optionScope: unitPoints,
      ordered: false,
      count: questionLimit,
      sameChoices: 5,
      otherChoices: 0,
    },
    "image-name-cumulative": {
      title: "위치→이름 (이전단원 포함)",
      promptType: "image",
      choiceType: "name",
      questionPool: cumulativePoints,
      optionScope: cumulativePoints,
      ordered: false,
      count: questionLimit,
      sameChoices: 3,
      otherChoices: 2,
    },
    "name-image-cumulative": {
      title: "이름→위치 (이전단원 포함)",
      promptType: "name",
      choiceType: "image",
      questionPool: cumulativePoints,
      optionScope: cumulativePoints,
      ordered: false,
      count: questionLimit,
      sameChoices: 2,
      otherChoices: 3,
      singleOtherMeridian: true,
    },
  };

  return configs[menuId];
}

function createSpecialQuizConfig(menuId) {
  const lessons = getImportantLessons();
  const cumulative = menuId.startsWith(SPECIAL_CUMULATIVE_PREFIX);
  const lessonId = menuId.replace(cumulative ? SPECIAL_CUMULATIVE_PREFIX : SPECIAL_QUIZ_PREFIX, "");
  const lessonIndex = lessons.findIndex((lesson) => lesson.id === lessonId);
  const lesson = lessons[lessonIndex];

  if (!lesson) {
    renderSpecialMenu();
    return null;
  }

  const targetLessons = cumulative ? lessons.slice(0, lessonIndex + 1) : [lesson];
  const questionPool = targetLessons.flatMap((item) => item.quizItems);

  return {
    kind: "special",
    title: cumulative ? `누적 퀴즈 1~${lessonIndex + 1}` : `${lesson.title} 퀴즈`,
    unitTitle: SPECIAL_UNIT_TITLE,
    questionPool,
    optionScope: cumulative ? data.important.quizItems : questionPool,
    count: Math.min(questionLimit, questionPool.length),
  };
}

function buildQuestions(config) {
  const answers = config.ordered
    ? [...config.questionPool]
    : takeRepeatedShuffle(config.questionPool, config.count);

  return answers.map((answer) => ({
    answerId: answer.id,
    choices: buildChoices(answer, config).map((point) => point.id),
  }));
}

function buildSpecialQuestions(config) {
  const answers = takeRepeatedShuffle(config.questionPool, config.count);

  return answers.map((answer) => ({
    prompt: answer.prompt,
    detail: answer.detail,
    answer: answer.answer,
    answerGroup: answer.answerGroup,
    choices: buildSpecialChoices(answer, config),
  }));
}

function buildSpecialChoices(answer, config) {
  const primaryOptions = config.optionScope || config.questionPool;
  const fallbackOptions = data.important?.quizItems || [];
  const fallbackTexts = SPECIAL_CHOICE_FALLBACKS[answer.answerGroup] || [];
  const allAnswers = [...primaryOptions, ...fallbackOptions]
    .filter((item) => item.answerGroup === answer.answerGroup)
    .map((item) => item.answer);
  const uniqueAnswerCount = new Set([...allAnswers, ...fallbackTexts].map(normalizeText)).size;
  const desiredCount = Math.max(1, Math.min(4, uniqueAnswerCount));
  const selected = new Map([[normalizeText(answer.answer), answer.answer]]);

  const addAnswers = (answers) => {
    for (const choice of shuffle(answers)) {
      if (selected.size >= desiredCount) break;
      const normalized = normalizeText(choice);
      if (!normalized || selected.has(normalized)) continue;
      selected.set(normalized, choice);
    }
  };

  addAnswers(primaryOptions.filter((item) => item.answerGroup === answer.answerGroup).map((item) => item.answer));
  addAnswers(fallbackOptions.filter((item) => item.answerGroup === answer.answerGroup).map((item) => item.answer));
  addAnswers(fallbackTexts);

  return shuffle([...selected.values()]);
}

function buildChoices(answer, config) {
  const desiredCount = 1 + config.sameChoices + config.otherChoices;
  const selected = new Map([[answer.id, answer]]);
  const selectedNames = new Set([normalizePointName(answer)]);

  const addFromPool = (pool, count) => {
    let added = 0;
    for (const point of shuffle(pool)) {
      if (added >= count) break;
      const pointName = normalizePointName(point);
      if (point.id === answer.id || selected.has(point.id) || selectedNames.has(pointName)) continue;
      selected.set(point.id, point);
      selectedNames.add(pointName);
      added += 1;
    }
    return added;
  };

  const sameScope = config.optionScope.filter(
    (point) => point.code === answer.code && point.id !== answer.id,
  );
  const sameFallback = allPoints.filter(
    (point) => point.code === answer.code && point.id !== answer.id,
  );
  const otherScope = config.optionScope.filter((point) => point.code !== answer.code);
  const otherFallback = allPoints.filter((point) => point.code !== answer.code);

  const sameAdded = addFromPool(sameScope, config.sameChoices);
  if (sameAdded < config.sameChoices) {
    addFromPool(sameFallback, config.sameChoices - sameAdded);
  }

  const otherAdded = config.singleOtherMeridian
    ? addFromSingleOtherMeridian(otherScope, otherFallback, config.otherChoices)
    : addFromPool(otherScope, config.otherChoices);
  if (otherAdded < config.otherChoices) {
    addFromPool(otherFallback, config.otherChoices - otherAdded);
  }

  if (selected.size < desiredCount) {
    addFromPool(allPoints, desiredCount - selected.size);
  }

  function addFromSingleOtherMeridian(primaryPool, fallbackPool, count) {
    const group = chooseSingleMeridianGroup(primaryPool, count) || chooseSingleMeridianGroup(fallbackPool, count);
    return group ? addFromPool(group, count) : 0;
  }

  function chooseSingleMeridianGroup(pool, count) {
    const groupsByCode = new Map();
    for (const point of pool) {
      const group = groupsByCode.get(point.code) || [];
      group.push(point);
      groupsByCode.set(point.code, group);
    }

    const groups = [...groupsByCode.values()];
    const enoughGroups = groups.filter((group) => group.length >= count);
    return shuffle(enoughGroups.length ? enoughGroups : groups)[0] || null;
  }

  return shuffle([...selected.values()]);
}

function renderQuiz() {
  if (!activeQuiz) {
    if (selectedSpecialUnit) {
      renderSpecialMenu();
    } else {
      renderMenu();
    }
    return;
  }

  if (activeQuiz.index >= activeQuiz.questions.length) {
    renderResult();
    return;
  }

  const question = activeQuiz.questions[activeQuiz.index];

  if (activeQuiz.kind === "special") {
    renderSpecialQuizQuestion(question);
    return;
  }

  const answer = pointById.get(question.answerId);
  const choices = question.choices.map((id) => pointById.get(id));

  app.innerHTML = `
    <section class="screen quiz-card">
      <div class="quiz-top">
        <button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>
        <span class="progress-pill">${activeQuiz.index + 1} / ${activeQuiz.questions.length}</span>
        <span></span>
      </div>

      <div class="screen-heading">
        <p class="kicker">${escapeHtml(selectedMeridian.name)}</p>
        <h2>${escapeHtml(activeQuiz.title)}</h2>
      </div>

      ${renderQuestionPrompt(answer)}
      ${renderChoices(choices, answer)}
      ${renderFeedback(answer)}
    </section>
  `;

  preloadUpcomingQuizImages(activeQuiz.index + 1);
}

function renderSpecialQuizQuestion(question) {
  app.innerHTML = `
    <section class="screen quiz-card">
      <div class="quiz-top">
        <button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>
        <span class="progress-pill">${activeQuiz.index + 1} / ${activeQuiz.questions.length}</span>
        <span></span>
      </div>

      <div class="screen-heading">
        <p class="kicker">${escapeHtml(activeQuiz.unitTitle)}</p>
        <h2>${escapeHtml(activeQuiz.title)}</h2>
      </div>

      ${renderSpecialQuestionPrompt(question)}
      ${renderSpecialChoices(question)}
      ${renderSpecialFeedback(question)}
    </section>
  `;
}

function renderSpecialQuestionPrompt(question) {
  return `
    <div class="question-name special-question">
      ${question.detail ? `<span>${escapeHtml(question.detail)}</span>` : ""}
      <strong>${escapeHtml(question.prompt)}</strong>
    </div>
  `;
}

function renderSpecialChoices(question) {
  return `
    <div class="choice-grid names">
      ${question.choices
        .map(
          (choice) => `
            <button
              class="answer-button ${getSpecialChoiceFeedbackClass(choice, question)}"
              type="button"
              data-action="answer"
              data-id="${escapeHtml(choice)}"
              ${activeQuiz.locked ? "disabled" : ""}
            >
              ${escapeHtml(choice)}
            </button>
          `,
        )
        .join("")}
    </div>
  `;
}

function preloadUpcomingStudyImages(startIndex) {
  const sources = [];

  for (let offset = 0; offset < IMAGE_PRELOAD_LOOKAHEAD; offset += 1) {
    const point = selectedMeridian?.points[startIndex + offset];
    if (point) sources.push(point.image);
  }

  preloadImages(sources);
}

function preloadUpcomingQuizImages(startIndex) {
  if (!activeQuiz) return;
  if (activeQuiz.kind === "special") return;

  const sources = [];

  for (let offset = 0; offset < IMAGE_PRELOAD_LOOKAHEAD; offset += 1) {
    const question = activeQuiz.questions[startIndex + offset];
    if (!question) continue;

    const answer = pointById.get(question.answerId);

    if (activeQuiz.promptType === "image" && answer) {
      sources.push(answer.image);
    }

    if (activeQuiz.choiceType === "image") {
      for (const id of question.choices) {
        const point = pointById.get(id);
        if (point) sources.push(point.image);
      }
    }
  }

  preloadImages(sources);
}

function preloadImages(sources) {
  for (const source of sources) {
    preloadImage(source);
  }
}

function preloadImage(source) {
  const src = String(source || "").trim();
  if (!src || imagePreloadCache.has(src)) return;

  const image = new Image();
  image.decoding = "async";
  image.onload = () => imagePreloadCache.set(src, true);
  image.onerror = () => imagePreloadCache.delete(src);
  imagePreloadCache.set(src, image);
  image.src = src;
}

function renderQuestionPrompt(answer) {
  if (activeQuiz.promptType === "image") {
    return `
      <figure class="image-panel">
        <img src="${escapeHtml(answer.image)}" alt="경혈 위치 이미지" />
      </figure>
    `;
  }

  return `
    <div class="question-name">
      <strong>${escapeHtml(answer.name)}</strong>
    </div>
  `;
}

function renderChoices(choices, answer) {
  const gridClass = activeQuiz.choiceType === "name" ? "names" : "images";
  return `
    <div class="choice-grid ${gridClass}">
      ${choices.map((choice) => renderChoice(choice, answer)).join("")}
    </div>
  `;
}

function renderChoice(choice, answer) {
  const feedbackClass = getChoiceFeedbackClass(choice, answer);
  const disabled = activeQuiz.locked ? "disabled" : "";

  if (activeQuiz.choiceType === "name") {
    return `
      <button
        class="answer-button ${feedbackClass}"
        type="button"
        data-action="answer"
        data-id="${escapeHtml(choice.id)}"
        ${disabled}
      >
        ${escapeHtml(choice.name)}
      </button>
    `;
  }

  return `
    <button
      class="image-choice ${feedbackClass}"
      type="button"
      data-action="answer"
      data-id="${escapeHtml(choice.id)}"
      data-preview-src="${escapeHtml(choice.image)}"
      data-preview-alt="경혈 위치 이미지 확대"
      aria-label="이미지 선택지"
      ${disabled}
    >
      <img src="${escapeHtml(choice.image)}" alt="" loading="lazy" />
    </button>
  `;
}

function handleImageChoicePointerDown(event) {
  const choice = event.target.closest(".image-choice");
  if (!choice || activeQuiz?.choiceType !== "image") return;
  if (event.pointerType === "mouse") return;

  clearImageLongPressTimer();
  imageLongPressTimer = setTimeout(() => {
    suppressImageChoiceClick = true;
    showImagePreview({
      src: choice.dataset.previewSrc,
      alt: choice.dataset.previewAlt,
    });
  }, IMAGE_LONG_PRESS_DELAY);
}

function clearImageLongPressTimer() {
  if (!imageLongPressTimer) return;
  clearTimeout(imageLongPressTimer);
  imageLongPressTimer = null;
}

function showImagePreview({ src, alt }) {
  clearImageLongPressTimer();
  if (!src) return;

  closeImagePreview();
  const preview = document.createElement("div");
  preview.className = "image-preview";
  preview.dataset.closeImagePreview = "";
  preview.innerHTML = `
    <figure class="image-preview-panel" role="dialog" aria-modal="true" aria-label="경혈 위치 이미지 확대">
      <button class="image-preview-close" type="button" data-close-image-preview aria-label="확대 이미지 닫기">×</button>
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "경혈 위치 이미지 확대")}" />
    </figure>
  `;
  document.body.append(preview);
}

function closeImagePreview() {
  const preview = document.querySelector(".image-preview");
  if (!preview) return false;
  preview.remove();
  return true;
}

function getChoiceFeedbackClass(choice, answer) {
  if (!activeQuiz.feedback) return "";

  const isAnswer = isPointChoiceCorrect(choice, answer);
  const isSelected = choice.id === activeQuiz.feedback.selectedId;

  if (activeQuiz.feedback.correct && isAnswer) return "is-correct";
  if (!activeQuiz.feedback.correct && isAnswer) return "correct-reveal";
  if (!activeQuiz.feedback.correct && isSelected) return "is-wrong";
  return "";
}

function getSpecialChoiceFeedbackClass(choice, question) {
  if (!activeQuiz.feedback) return "";

  const isAnswer = normalizeText(choice) === normalizeText(question.answer);
  const isSelected = normalizeText(choice) === normalizeText(activeQuiz.feedback.selectedId);

  if (activeQuiz.feedback.correct && isAnswer) return "is-correct";
  if (!activeQuiz.feedback.correct && isAnswer) return "correct-reveal";
  if (!activeQuiz.feedback.correct && isSelected) return "is-wrong";
  return "";
}

function renderFeedback(answer) {
  if (!activeQuiz.feedback) return "";

  if (activeQuiz.feedback.correct) {
    return `<div class="feedback">정답입니다</div>`;
  }

  return `<div class="feedback is-wrong">정답: ${escapeHtml(answer.name)}</div>`;
}

function renderSpecialFeedback(question) {
  if (!activeQuiz.feedback) return "";

  if (activeQuiz.feedback.correct) {
    return `<div class="feedback">정답입니다</div>`;
  }

  return `<div class="feedback is-wrong">정답: ${escapeHtml(question.answer)}</div>`;
}

function handleAnswer(selectedId) {
  if (!activeQuiz || activeQuiz.locked) return;

  const question = activeQuiz.questions[activeQuiz.index];
  const correct = activeQuiz.kind === "special"
    ? normalizeText(selectedId) === normalizeText(question.answer)
    : isPointAnswerCorrect(selectedId, question);

  activeQuiz.locked = true;
  activeQuiz.feedback = { selectedId, correct };

  if (correct) {
    activeQuiz.correct += 1;
  } else {
    if (activeQuiz.kind === "special") {
      activeQuiz.wrong.push({
        kind: "special",
        prompt: question.prompt,
        detail: question.detail,
        answer: question.answer,
        selected: selectedId,
      });
    } else {
      activeQuiz.wrong.push({
        answerId: question.answerId,
        selectedId,
        promptType: activeQuiz.promptType,
        choiceType: activeQuiz.choiceType,
      });
    }
  }

  renderQuiz();

  feedbackTimer = setTimeout(
    () => {
      activeQuiz.index += 1;
      activeQuiz.locked = false;
      activeQuiz.feedback = null;
      renderQuiz();
    },
    correct ? 650 : 1500,
  );
}

function isPointAnswerCorrect(selectedId, question) {
  if (selectedId === question.answerId) return true;
  if (activeQuiz.choiceType !== "name") return false;

  const answer = pointById.get(question.answerId);
  const selected = pointById.get(selectedId);
  return normalizePointName(answer) === normalizePointName(selected);
}

function isPointChoiceCorrect(choice, answer) {
  if (choice.id === answer.id) return true;
  if (activeQuiz.choiceType !== "name") return false;
  return normalizePointName(choice) === normalizePointName(answer);
}

function renderResult() {
  const total = activeQuiz.questions.length;
  const score = total ? Math.round((activeQuiz.correct / total) * 100) : 0;
  const wrongCount = activeQuiz.wrong.length;

  app.innerHTML = `
    <section class="screen result-panel">
      <div class="study-top">
        <button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>
        <span class="progress-pill">완료</span>
        <span></span>
      </div>

      <div class="screen-heading">
        <p class="kicker">${escapeHtml(activeQuiz.title)}</p>
        <h2>결과</h2>
      </div>

      <section class="score-box">
        <p class="muted">맞춘 문제</p>
        <strong class="score-number">${activeQuiz.correct} / ${total}</strong>
        <p>점수 ${score}점</p>
      </section>

      ${renderWrongReview(wrongCount)}

      <div class="result-actions">
        <button class="result-action secondary" type="button" data-action="retry">다시</button>
        <button class="result-action" type="button" data-action="back-menu">메뉴</button>
      </div>
    </section>
  `;
}

function renderWrongReview(wrongCount) {
  if (wrongCount === 0) {
    return `<div class="empty-state">틀린 문제가 없습니다.</div>`;
  }

  if (wrongCount > 10) {
    return `<div class="empty-state">틀린 문제가 ${wrongCount}개입니다.</div>`;
  }

  return `
    <section class="screen">
      <h3>틀린 문제</h3>
      <ul class="wrong-list">
        ${activeQuiz.wrong.map((record) => (record.kind === "special" ? renderSpecialWrongItem(record) : renderWrongItem(record))).join("")}
      </ul>
    </section>
  `;
}

function renderWrongItem(record) {
  const answer = pointById.get(record.answerId);
  const selected = pointById.get(record.selectedId);
  const questionText =
    record.promptType === "name" ? `문제: ${answer.name}` : "문제: 위치 이미지";

  return `
    <li class="wrong-item">
      <img src="${escapeHtml(answer.image)}" alt="" loading="lazy" />
      <div>
        <strong>${escapeHtml(questionText)}</strong>
        <p>정답: ${escapeHtml(answer.name)}</p>
        <p class="muted">선택: ${escapeHtml(selected.name)}</p>
      </div>
    </li>
  `;
}

function renderSpecialWrongItem(record) {
  return `
    <li class="wrong-item text-only">
      <div>
        <strong>${escapeHtml(record.prompt)}</strong>
        ${record.detail ? `<p class="muted">${escapeHtml(record.detail)}</p>` : ""}
        <p>정답: ${escapeHtml(record.answer)}</p>
        <p class="muted">선택: ${escapeHtml(record.selected)}</p>
      </div>
    </li>
  `;
}

function openSearch() {
  if (!data) return;
  searchSheet.hidden = false;
  searchInput.value = "";
  renderSearchResults("");
  requestAnimationFrame(() => searchInput.focus());
}

function closeSearch() {
  searchSheet.hidden = true;
}

function renderSearchResults(query) {
  const keyword = normalizeText(query);

  if (!keyword) {
    searchResults.innerHTML = `<div class="empty-state">검색어를 입력하세요.</div>`;
    return;
  }

  const matches = allPoints
    .filter((point) => getPointSearchText(point).includes(keyword))
    .slice(0, 50);

  if (!matches.length) {
    searchResults.innerHTML = `<div class="empty-state">검색 결과가 없습니다.</div>`;
    return;
  }

  searchResults.innerHTML = matches
    .map(
      (point) => `
        <button class="search-result" type="button" data-id="${escapeHtml(point.id)}">
          <img src="${escapeHtml(point.image)}" alt="" loading="lazy" />
          <span>
            <strong>${escapeHtml(point.name)}</strong>
            <span>${escapeHtml(point.meridianName)}</span>
            ${point.aliases?.length ? `<span>별칭: ${escapeHtml(point.aliases.join(", "))}</span>` : ""}
          </span>
        </button>
      `,
    )
    .join("");
}

function handleSearchResultClick(event) {
  const result = event.target.closest(".search-result");
  if (!result) return;

  const point = pointById.get(result.dataset.id);
  if (!point) return;
  closeSearch();
  startStudy(point.code, point.id);
}

function getPointSearchText(point) {
  return normalizeText([point.name, ...(point.aliases || [])].join(" "));
}

function takeRepeatedShuffle(pool, count) {
  const result = [];
  if (!pool.length || count <= 0) return result;

  while (result.length < count) {
    const shuffled = shuffle(pool);
    for (const item of shuffled) {
      if (result.length >= count) break;
      result.push(item);
    }
  }
  return result;
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function normalizeText(value) {
  return String(value).trim().toLocaleLowerCase("ko-KR");
}

function normalizePointName(point) {
  return normalizeText(point?.name || "");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}
