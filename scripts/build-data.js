const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const referencesDir = path.join(rootDir, "assets", "references");
const outputDir = path.join(rootDir, "assets", "json");

const meridianSourcePath = path.join(referencesDir, "MeridianPoints.txt");
const locationSourcePath = path.join(referencesDir, "LocationAndIndications.txt");
const importantSourcePath = path.join(referencesDir, "ImportantMeridianPoints.txt");

const meridianSource = fs.readFileSync(meridianSourcePath, "utf8");
const locationSource = fs.readFileSync(locationSourcePath, "utf8");
const importantSource = fs.readFileSync(importantSourcePath, "utf8");

const MERIDIAN_ORDER = ["LU", "LI", "ST", "SP", "HT", "SI", "BL", "KI", "PC", "TE", "GB", "LR", "CV", "GV"];
const KEY_POINT_TYPES = ["수혈", "모혈", "낙혈", "극혈"];
const FIVE_SHU_ORDER = ["정혈", "형혈", "수혈", "경혈", "합혈"];
const FIVE_PHASE_ORDER = ["목혈", "화혈", "토혈", "금혈", "수혈"];

const MERIDIAN_ALIASES = {
  폐경: "LU",
  대장경: "LI",
  위경: "ST",
  비경: "SP",
  심경: "HT",
  소장경: "SI",
  방광경: "BL",
  신경: "KI",
  심포경: "PC",
  삼초경: "TE",
  담경: "GB",
  간경: "LR",
  임맥: "CV",
  독맥: "GV",
};

function parseMeridians(source) {
  const lines = source.split(/\r?\n/);
  const meridians = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const heading = trimmed.match(/^(.+?)\(([A-Z]{1,2})\)$/);
    if (heading) {
      current = {
        order: meridians.length + 1,
        code: heading[2],
        name: heading[1].trim(),
        points: [],
      };
      meridians.push(current);
      continue;
    }

    if (!current) continue;

    const pointMatches = [...trimmed.matchAll(/([^\s()]+)\(([A-Z]{1,2})(\d+)\)/g)];
    for (const match of pointMatches) {
      const code = match[2];
      const number = Number(match[3]);
      const id = `${code}${number}`;

      current.points.push({
        id,
        code,
        number,
        name: match[1],
        image: `assets/images/${code}/${id}.webp`,
        location: [],
        technique: [],
      });
    }
  }

  return meridians;
}

function parseLocationDetails(source, meridians) {
  const lines = source.split(/\r?\n/);
  const warnings = [];
  let currentMeridian = null;
  let currentPoint = null;
  let currentField = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    const section = trimmed.match(/^@@@\s*경맥과 경혈(\d{1,2})\((.+?)\)\s*@@@$/);
    if (section) {
      const order = Number(section[1]);
      currentMeridian = meridians[order - 1] || null;
      currentPoint = null;
      currentField = null;
      if (!currentMeridian) {
        warnings.push(`Location section ${order} has no matching meridian.`);
      }
      continue;
    }

    const entry = trimmed.match(/^(\d{1,2})\)\s*(.+?)(?:\s*:\s*(.+))?$/);
    if (entry && currentMeridian) {
      const pointNumber = Number(entry[1]);
      currentPoint = currentMeridian.points[pointNumber - 1] || null;
      currentField = null;

      if (!currentPoint) {
        warnings.push(`${currentMeridian.code} entry ${pointNumber} has no matching point.`);
        continue;
      }

      currentPoint.note = entry[3] ? entry[3].trim() : "";
      const sourceName = entry[2].replace(/\(.+\)$/, "").trim();
      if (sourceName && sourceName !== currentPoint.name) {
        warnings.push(`${currentPoint.id} name differs: list="${currentPoint.name}", location="${sourceName}".`);
      }
      continue;
    }

    if (!currentPoint) continue;

    if (/^##\s*위치/.test(trimmed)) {
      currentField = "location";
      continue;
    }

    if (/^##\s*취혈요령/.test(trimmed)) {
      currentField = "technique";
      continue;
    }

    if (!currentField || !trimmed || trimmed.startsWith("<") || trimmed.startsWith("@@")) {
      continue;
    }

    const cleaned = trimmed.replace(/^-\s*/, "").trim();
    if (cleaned) {
      currentPoint[currentField].push(cleaned);
    }
  }

  return warnings;
}

function reorderMeridians(meridians) {
  const byCode = new Map(meridians.map((meridian) => [meridian.code, meridian]));
  const ordered = MERIDIAN_ORDER.map((code) => byCode.get(code)).filter(Boolean);
  const remaining = meridians.filter((meridian) => !MERIDIAN_ORDER.includes(meridian.code));

  return [...ordered, ...remaining].map((meridian, index) => {
    meridian.order = index + 1;
    return meridian;
  });
}

function applyPointAliases(meridians) {
  const li19 = meridians.flatMap((meridian) => meridian.points).find((point) => point.id === "LI19");
  if (li19) li19.aliases = ["구화료"];
}

function parseImportantData(source, meridians) {
  const context = createImportantContext(meridians);
  const keyPoints = [];
  const fiveShuAndFivePhase = [];
  const fiveByCode = new Map();
  let section = "";
  let currentCode = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (/^##\s*요혈/.test(trimmed)) {
      section = "key";
      currentCode = null;
      continue;
    }

    if (/^##\s*오수혈/.test(trimmed)) {
      section = "five";
      currentCode = null;
      continue;
    }

    const keyHeading = trimmed.match(/^\*\*(.+?)\(([A-Z]{1,2})\)\*\*:\s*(.+)$/);
    if (section === "key" && keyHeading) {
      const code = keyHeading[2];
      const meridian = context.meridianByCode.get(code);
      keyPoints.push({
        code,
        meridianName: meridian?.name || keyHeading[1].trim(),
        items: parseKeyPointItems(keyHeading[3], code, context),
      });
      continue;
    }

    const fiveHeading = trimmed.match(/^\*\*(.+?)\(([A-Z]{1,2})\)\*\*$/);
    if (section === "five" && fiveHeading) {
      currentCode = fiveHeading[2];
      const meridian = context.meridianByCode.get(currentCode);
      const entry = {
        code: currentCode,
        meridianName: meridian?.name || fiveHeading[1].trim(),
        fiveShu: [],
        fivePhase: [],
      };
      fiveShuAndFivePhase.push(entry);
      fiveByCode.set(currentCode, entry);
      continue;
    }

    const fiveList = trimmed.match(/^\*\s+\*\*(오수혈|오행혈)\*\*:\s*(.+)$/);
    if (section === "five" && currentCode && fiveList) {
      const entry = fiveByCode.get(currentCode);
      const target = fiveList[1] === "오수혈" ? "fiveShu" : "fivePhase";
      entry[target] = parsePointCategoryList(fiveList[2], currentCode, context);
    }
  }

  const important = {
    keyPoints,
    fiveShuAndFivePhase,
  };
  const lessons = buildImportantLessons(important, context);

  return {
    ...important,
    lessons,
    quizItems: lessons.flatMap((lesson) => lesson.quizItems),
  };
}

function parseKeyPointItems(text, ownerCode, context) {
  const items = [];
  const itemPattern = /(수혈|낙혈|극혈|모혈)\s*([^,()\s]+)?(?:\(([^)]*)\))?/g;
  for (const match of text.matchAll(itemPattern)) {
    const type = match[1];
    const relatedMeridian = (match[3] || "").trim();
    let pointName = (match[2] || "").trim();

    if (!pointName && relatedMeridian === "심포경") {
      pointName = "단중";
    }

    const point = resolvePoint(pointName, ownerCode, relatedMeridian, context);
    items.push({
      type,
      pointName,
      pointId: point?.id || "",
      pointCode: point?.code || "",
      pointNumber: point?.number || null,
      relatedMeridian,
      relatedCode: getMeridianCode(relatedMeridian, context) || "",
    });
  }
  return items;
}

function parsePointCategoryList(text, ownerCode, context) {
  return [...text.matchAll(/([^,()]+)\(([^)]+)\)/g)].map((match) => {
    const pointName = match[1].trim();
    const category = match[2].trim();
    const point = resolvePoint(pointName, ownerCode, "", context);
    return {
      pointName,
      category,
      pointId: point?.id || "",
      pointCode: point?.code || "",
      pointNumber: point?.number || null,
    };
  });
}

function createImportantContext(meridians) {
  const meridianByCode = new Map(meridians.map((meridian) => [meridian.code, meridian]));
  const meridianCodeByName = new Map();
  const nameToPoints = new Map();

  for (const meridian of meridians) {
    meridianCodeByName.set(normalizeLabel(meridian.name), meridian.code);
    for (const point of meridian.points) {
      const list = nameToPoints.get(point.name) || [];
      list.push(point);
      nameToPoints.set(point.name, list);
    }
  }

  for (const [alias, code] of Object.entries(MERIDIAN_ALIASES)) {
    meridianCodeByName.set(normalizeLabel(alias), code);
  }

  return {
    meridians,
    meridianByCode,
    meridianCodeByName,
    nameToPoints,
  };
}

function resolvePoint(pointName, ownerCode, relatedMeridian, context) {
  if (!pointName) return null;

  const candidates = context.nameToPoints.get(pointName) || [];
  if (!candidates.length) return null;
  if (candidates.length === 1) return candidates[0];

  const relatedCode = getMeridianCode(relatedMeridian, context);
  const preferredCodes = [];

  if (ownerCode === "CV" || ownerCode === "GV") preferredCodes.push(ownerCode);
  if (relatedCode) preferredCodes.push(relatedCode);
  preferredCodes.push(ownerCode);

  for (const code of [...new Set(preferredCodes)]) {
    const point = candidates.find((candidate) => candidate.code === code);
    if (point) return point;
  }

  return candidates[0];
}

function getMeridianCode(value, context) {
  if (!value) return "";
  return context.meridianCodeByName.get(normalizeLabel(value)) || "";
}

function normalizeLabel(value) {
  return String(value || "").replace(/\s+/g, "").trim();
}

function buildImportantLessons(important, context) {
  const keyByCode = new Map(important.keyPoints.map((entry) => [entry.code, entry]));
  const fiveByCode = new Map(important.fiveShuAndFivePhase.map((entry) => [entry.code, entry]));
  const definitions = [
    {
      id: "key-back-front-1",
      title: "요혈 1: 수혈·모혈 앞부분",
      intro: "먼저 수혈과 모혈을 장부별 짝으로 봅니다. 앞 여섯 경맥은 익숙한 흐름을 만들기 좋습니다.",
      kind: "key",
      codes: ["LU", "LI", "ST", "SP", "HT", "SI"],
      types: ["수혈", "모혈"],
    },
    {
      id: "key-back-front-2",
      title: "요혈 2: 수혈·모혈 뒷부분",
      intro: "뒤 여섯 경맥과 임맥·독맥은 위치 경맥이 섞입니다. 어느 경맥의 혈인지 함께 붙여 봅니다.",
      kind: "key",
      codes: ["BL", "KI", "PC", "TE", "GB", "LR", "CV", "GV"],
      types: ["수혈", "모혈"],
    },
    {
      id: "key-luo-xi-1",
      title: "요혈 3: 낙혈·극혈 앞부분",
      intro: "낙혈과 극혈은 이름만 따로 외우기보다 같은 경맥 안에서 한 쌍으로 묶으면 부담이 줄어듭니다.",
      kind: "key",
      codes: ["LU", "LI", "ST", "SP", "HT", "SI"],
      types: ["낙혈", "극혈"],
    },
    {
      id: "key-luo-xi-2",
      title: "요혈 4: 낙혈·극혈 뒷부분",
      intro: "나머지 경맥의 낙혈·극혈을 이어 붙입니다. 임맥과 독맥은 낙혈만 짧게 확인합니다.",
      kind: "key",
      codes: ["BL", "KI", "PC", "TE", "GB", "LR", "CV", "GV"],
      types: ["낙혈", "극혈"],
    },
    {
      id: "five-shu-yin",
      title: "오수혈 1: 음경",
      intro: "음경의 오수혈은 정·형·수·경·합 순서로 손끝과 발끝에서 몸쪽으로 올라갑니다.",
      kind: "fiveShu",
      codes: ["LU", "SP", "HT", "KI", "PC", "LR"],
      categories: FIVE_SHU_ORDER,
    },
    {
      id: "five-shu-yang",
      title: "오수혈 2: 양경",
      intro: "양경도 같은 정·형·수·경·합 순서를 씁니다. 같은 이름의 혈이 있는지까지 조심해서 봅니다.",
      kind: "fiveShu",
      codes: ["LI", "ST", "SI", "BL", "TE", "GB"],
      categories: FIVE_SHU_ORDER,
    },
    {
      id: "five-phase-yin",
      title: "오행혈 1: 음경",
      intro: "음경의 오행혈은 목·화·토·금·수 순서입니다. 오수혈 순서 위에 오행을 한 줄 더 얹어 봅니다.",
      kind: "fivePhase",
      codes: ["LU", "SP", "HT", "KI", "PC", "LR"],
      categories: FIVE_PHASE_ORDER,
    },
    {
      id: "five-phase-yang",
      title: "오행혈 2: 양경",
      intro: "양경의 오행혈은 금·수·목·화·토 순서입니다. 음경과 시작점이 다르다는 점을 붙잡으면 훨씬 빨라집니다.",
      kind: "fivePhase",
      codes: ["LI", "ST", "SI", "BL", "TE", "GB"],
      categories: ["금혈", "수혈", "목혈", "화혈", "토혈"],
    },
  ];

  return definitions.map((definition, index) => buildImportantLesson(definition, index, keyByCode, fiveByCode, context));
}

function buildImportantLesson(definition, index, keyByCode, fiveByCode, context) {
  const rows = [];
  const quizItems = [];

  for (const code of definition.codes) {
    const meridian = context.meridianByCode.get(code);
    if (!meridian) continue;

    if (definition.kind === "key") {
      const values = (keyByCode.get(code)?.items || [])
        .filter((item) => definition.types.includes(item.type))
        .map((item) => ({
          label: item.type,
          value: formatPointNameWithId(item),
          pointId: item.pointId,
          detail: buildImportantDetail(item, context),
        }));

      if (!values.length) continue;

      rows.push({
        label: `${meridian.name}(${code})`,
        values,
      });

      for (const item of (keyByCode.get(code)?.items || []).filter((entry) => definition.types.includes(entry.type))) {
        quizItems.push({
          prompt: buildKeyPointPrompt(meridian, item),
          answer: item.pointName,
          answerGroup: `key-point-${item.type}`,
          detail: `${meridian.name} ${item.type}`,
        });
        quizItems.push({
          prompt: `${item.pointName}은 ${meridian.name}에서 어떤 요혈?`,
          answer: item.type,
          answerGroup: "key-type",
          detail: formatPointNameWithId(item),
        });
      }
      continue;
    }

    const fiveEntry = fiveByCode.get(code);
    const sourceItems = definition.kind === "fiveShu" ? fiveEntry?.fiveShu || [] : fiveEntry?.fivePhase || [];
    const values = definition.categories
      .map((category) => sourceItems.find((item) => item.category === category))
      .filter(Boolean)
      .map((item) => ({
        label: item.category,
        value: formatPointNameWithId(item),
        pointId: item.pointId,
        detail: "",
      }));

    if (!values.length) continue;

    rows.push({
      label: `${meridian.name}(${code})`,
      values,
    });

    for (const item of sourceItems) {
      const group = definition.kind === "fiveShu" ? "five-shu" : "five-phase";
      const label = definition.kind === "fiveShu" ? "오수혈" : "오행혈";
      quizItems.push({
        prompt: `${meridian.name}의 ${item.category}은?`,
        answer: item.pointName,
        answerGroup: `${group}-point`,
        detail: `${meridian.name} ${label}`,
      });
      quizItems.push({
        prompt: `${item.pointName}은 ${meridian.name}의 ${label}에서?`,
        answer: item.category,
        answerGroup: `${group}-category`,
        detail: formatPointNameWithId(item),
      });
    }
  }

  return {
    id: definition.id,
    order: index + 1,
    title: definition.title,
    intro: definition.intro,
    kind: definition.kind,
    rows,
    quizItems,
  };
}

function buildKeyPointPrompt(meridian, item) {
  if ((meridian.code === "CV" || meridian.code === "GV") && item.relatedMeridian) {
    return `${meridian.name}에서 ${item.relatedMeridian}의 ${item.type}은?`;
  }
  return `${meridian.name}의 ${item.type}은?`;
}

function buildImportantDetail(item, context) {
  if (!item.pointCode) return item.relatedMeridian || "";
  const meridian = context.meridianByCode.get(item.pointCode);
  const pointPlace = meridian ? `${meridian.name} ${item.pointId}` : item.pointId;

  if (item.relatedMeridian && (item.pointCode === "CV" || item.pointCode === "GV")) {
    return `${item.relatedMeridian}의 ${item.type}, ${pointPlace}`;
  }

  return pointPlace;
}

function formatPointNameWithId(item) {
  return item.pointId ? `${item.pointName}(${item.pointId})` : item.pointName;
}

function validate(meridians) {
  const warnings = [];
  const points = meridians.flatMap((meridian) => meridian.points);
  const ids = new Set();

  for (const point of points) {
    if (ids.has(point.id)) warnings.push(`Duplicate point id ${point.id}.`);
    ids.add(point.id);

    const imagePath = path.join(rootDir, point.image);
    if (!fs.existsSync(imagePath)) warnings.push(`${point.id} image missing: ${point.image}`);
    if (!point.location.length) warnings.push(`${point.id} has no location text.`);
    if (!point.technique.length) warnings.push(`${point.id} has no technique text.`);
  }

  return warnings;
}

const meridians = parseMeridians(meridianSource);
const parseWarnings = parseLocationDetails(locationSource, meridians);
const orderedMeridians = reorderMeridians(meridians);
applyPointAliases(orderedMeridians);
const important = parseImportantData(importantSource, orderedMeridians);
const validationWarnings = validate(orderedMeridians);
const totalPoints = orderedMeridians.reduce((sum, meridian) => sum + meridian.points.length, 0);

const data = {
  version: 1,
  sourceFiles: [
    "assets/references/MeridianPoints.txt",
    "assets/references/LocationAndIndications.txt",
    "assets/references/ImportantMeridianPoints.txt",
  ],
  totalPoints,
  meridians: orderedMeridians,
  important,
};

fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "meridians.json"), `${JSON.stringify(data, null, 2)}\n`, "utf8");

console.log(`Wrote assets/json/meridians.json`);
console.log(`Meridians: ${meridians.length}`);
console.log(`Points: ${totalPoints}`);

const warnings = [...parseWarnings, ...validationWarnings];
if (warnings.length) {
  console.warn(`Warnings: ${warnings.length}`);
  for (const warning of warnings) console.warn(`- ${warning}`);
  process.exitCode = 1;
}
