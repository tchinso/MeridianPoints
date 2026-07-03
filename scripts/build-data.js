const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const referencesDir = path.join(rootDir, "assets", "references");
const outputDir = path.join(rootDir, "assets", "json");

const meridianSourcePath = path.join(referencesDir, "MeridianPoints.txt");
const locationSourcePath = path.join(referencesDir, "LocationAndIndications.txt");

const meridianSource = fs.readFileSync(meridianSourcePath, "utf8");
const locationSource = fs.readFileSync(locationSourcePath, "utf8");

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
const validationWarnings = validate(meridians);
const totalPoints = meridians.reduce((sum, meridian) => sum + meridian.points.length, 0);

const data = {
  version: 1,
  sourceFiles: [
    "assets/references/MeridianPoints.txt",
    "assets/references/LocationAndIndications.txt",
  ],
  totalPoints,
  meridians,
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
