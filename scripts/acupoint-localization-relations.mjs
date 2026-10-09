/**
 * Anatomical learning relationships grounded in the repository's location text.
 * A shared source-defined level/line is required: mesh distances and meridian
 * number order never establish a relationship. Coordinates remain a separate
 * model-fit estimate and do not establish clinical approval of this source.
 */

const CATEGORIES = ["horizontal", "vertical", "reference"];
const MIDLINE_CODES = new Set(["CV", "GV"]);
const VERTICAL_LIMIT = 4;
const fieldEntries = (point) => [
  ...["location", "technique"].flatMap((field) => (point[field] || []).map((text) => ({ pointId: point.id, field, text }))),
  ...(typeof point.note === "string" && point.note.trim() ? [{ pointId: point.id, field: "note", text: point.note }] : []),
];
const uniqueEvidence = (entries) => [...new Map(entries.map((entry) => [`${entry.pointId}:${entry.field}:${entry.text}`, entry])).values()];
const sequence = (code, first, last) => Array.from({ length: last - first + 1 }, (_, index) => `${code}${first + index}`);
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function buildLocalizationRelations(sourcePoints) {
  const source = new Map(sourcePoints.map((point) => [point.id, point]));
  const result = new Map(sourcePoints.map((point) => [point.id, {
    horizontal: [],
    vertical: [],
    reference: [],
    // Preserve the written landmarks even when no other acupoint is a
    // documented reference. An empty category deliberately has no fallback.
    landmarks: [...point.location],
    evidencePolicy: "source-text-only",
    reviewStatus: "source-text-derived-not-clinically-reviewed",
  }]));

  const evidenceFrom = (id, pattern = /./) => {
    const point = source.get(id);
    if (!point) throw new Error(`Unknown localisation source point ${id}.`);
    const entry = fieldEntries(point).find(({ text }) => pattern.test(text));
    if (!entry) throw new Error(`${id} has no source evidence matching ${pattern}.`);
    return entry;
  };
  const add = (id, category, targetId, label, description, evidence) => {
    if (id === targetId) return;
    const target = source.get(targetId);
    if (!target) throw new Error(`${id} has an unknown localisation target ${targetId}.`);
    const entries = result.get(id)[category];
    if (entries.some((entry) => entry.pointId === targetId)) return;
    entries.push({
      pointId: targetId,
      label,
      description,
      instancePolicy: MIDLINE_CODES.has(target.code) ? "midline" : "same-side",
      evidence: uniqueEvidence(evidence),
    });
  };
  const group = (category, ids, label, description, evidenceFor, commonEvidence = []) => {
    const evidence = new Map(ids.map((id) => [id, evidenceFor(id)]));
    for (const [index, id] of ids.entries()) {
      let targets = ids.map((pointId, targetIndex) => ({ pointId, targetIndex })).filter(({ pointId }) => pointId !== id);
      if (category === "vertical") {
        // The order is explicitly authored along this documented anatomical
        // line. Limit its visible neighbours; this is not a meridian sequence
        // or a geometric nearest-marker fallback.
        targets = targets.sort((a, b) => Math.abs(a.targetIndex - index) - Math.abs(b.targetIndex - index) || a.targetIndex - b.targetIndex)
          .slice(0, VERTICAL_LIMIT);
      }
      for (const { pointId } of targets) {
        add(id, category, pointId, label, description, [...commonEvidence, evidence.get(id), evidence.get(pointId)]);
      }
    }
  };

  // Exact intercostal spaces in the chest, including their sternal level.
  // "Same intercostal space" does not claim a flat Cartesian mesh plane: the
  // space follows the ribs around the thorax.
  const chestLevels = [
    [1, ["CV20", "KI26", "ST14"]],
    [2, ["CV19", "KI25", "ST15", "SP20"]],
    [3, ["CV18", "KI24", "ST16", "SP19"]],
    [4, ["CV17", "KI23", "ST17", "PC1", "SP18", "GB23", "GB22"]],
    [5, ["CV16", "KI22", "ST18", "SP17"]],
    [7, ["GB24", "SP21"]],
  ];
  for (const [level, ids] of chestLevels) {
    group("horizontal", ids, `제${level}늑간`, `흉곽의 제${level}늑간을 공유합니다. 늑간은 갈비뼈를 따라 이어집니다.`,
      (id) => evidenceFrom(id, new RegExp(`(?:제\\s*)?${level}\\s*늑(?:골)?간`)));
  }
  group("horizontal", ["CV21", "KI27", "ST13"], "선기 높이 · 쇄골하부", "선기와 그 양옆으로 명시된 쇄골하부의 취혈 높이입니다.",
    (id) => evidenceFrom(id, id === "CV21" ? /흉골정중선/ : /선기/));

  // Navel-relative transverse levels in the anterior abdomen. A member must
  // explicitly name that level's midline point or the navel; lateral points
  // are never pooled merely because their generated mesh heights are close.
  const abdomenLevels = [
    [6, ["CV14", "KI21", "ST19", "LR14"]],
    [5, ["CV13", "KI20", "ST20"]],
    [4, ["CV12", "KI19", "ST21"]],
    [3, ["CV11", "KI18", "ST22", "SP16"]],
    [2, ["CV10", "KI17", "ST23"]],
    [1, ["CV9", "ST24"]],
    [0, ["CV8", "KI16", "ST25", "SP15", "GB26"]],
    [-1, ["CV7", "KI15", "ST26"]],
    [-2, ["CV5", "KI14", "ST27"]],
    [-3, ["CV4", "KI13", "ST28", "GB27"]],
    [-4, ["CV3", "KI12", "ST29"]],
    [-5, ["CV2", "KI11", "ST30", "LR12", "SP12"]],
  ];
  for (const [offset, ids] of abdomenLevels) {
    const midline = ids[0];
    const midlineName = source.get(midline).name;
    const label = offset === 0 ? "배꼽 높이" : `배꼽 ${offset > 0 ? "위" : "아래"} ${Math.abs(offset)}촌 · ${midlineName} 높이`;
    group("horizontal", ids, label, `원문에 명시된 ${offset === 0 ? "배꼽" : midlineName}의 수평 취혈 높이를 공유합니다.`,
      (id) => evidenceFrom(id, id === midline ? /제중|제부/ : new RegExp(`${midlineName}|제중|제부|배꼽`)));
  }

  // Vertebral levels refer to the depression below the named spinous process,
  // not to a different vertebra with a coincident mesh Y coordinate.
  const backLevels = [
    ["제1흉추 극돌기 아래", ["GV13", "BL11"]],
    ["제2흉추 극돌기 아래", ["BL12", "BL41"]],
    ["제3흉추 극돌기 아래", ["GV12", "BL13", "BL42"]],
    ["제4흉추 극돌기 아래", ["BL14", "BL43"]],
    ["제5흉추 극돌기 아래", ["GV11", "BL15", "BL44"]],
    ["제6흉추 극돌기 아래", ["GV10", "BL16", "BL45"]],
    ["제7흉추 극돌기 아래", ["GV9", "BL17", "BL46"]],
    ["제9흉추 극돌기 아래", ["GV8", "BL18", "BL47"]],
    ["제10흉추 극돌기 아래", ["GV7", "BL19", "BL48"]],
    ["제11흉추 극돌기 아래", ["GV6", "BL20", "BL49"]],
    ["제12흉추 극돌기 아래", ["BL21", "BL50"]],
    ["제1요추 극돌기 아래", ["GV5", "BL22", "BL51"]],
    ["제2요추 극돌기 아래", ["GV4", "BL23", "BL52"]],
    ["제4요추 극돌기 아래", ["GV3", "BL25"]],
    ["제1후천골공 높이", ["BL31", "BL27"]],
    ["제2후천골공 높이", ["BL32", "BL28", "BL53"]],
    ["제3후천골공 높이", ["BL33", "BL29"]],
    ["제4후천골공 높이", ["BL34", "BL30", "BL54"]],
  ];
  for (const [label, ids] of backLevels) {
    group("horizontal", ids, label, `등·천골부에서 ${label}를 기준으로 취혈합니다.`, (id) => evidenceFrom(id));
  }

  // Short, explicitly documented transverse sets outside the torso.
  const otherLevels = [
    [["ST9", "LI18"], "후두융기 높이", "LI18", /인영혈.*같은 높이/],
    [["GV26", "LI19"], "수구(인중) 높이", "LI19", /인중과 수평|수구혈/],
    [["LI20", "SI18"], "영향 높이", "SI18", /영향혈과 같은 높이/],
    [["GV16", "GB20", "GB12"], "풍부 높이", "GB20", /풍부혈 상평/],
    [["GV17", "BL9", "GB19"], "뇌호 높이", "GB19", /뇌호혈.*같은 높이/],
    [["GV24", "BL4", "GB15", "GB13", "ST8"], "전발제 위 0.5촌 · 신정 높이", "GB13", /같은 선상에 신정/],
    [["BL7", "GB18"], "통천 높이", "GB18", /통천혈.*같은 높이/],
    [["BL40", "BL39", "KI10", "LR8"], "슬와횡문 높이", "LR8", /위중혈.*같은 높이/],
    [["PC8", "HT8"], "노궁과 소부의 상평선", "HT8", /노궁과 상평/],
  ];
  for (const [ids, label, evidenceId, pattern] of otherLevels) {
    group("horizontal", ids, label, "원문에 명시된 같은 높이의 취혈 관계입니다.", (id) => evidenceFrom(id), [evidenceFrom(evidenceId, pattern)]);
  }

  // Longitudinal lines are deliberately separated at changes in region or
  // lateral offset. For example, the KI abdominal 0.5-cun line is not the KI
  // chest 2-cun line, and the ST chest 4-cun line is not its abdominal line.
  const verticalLines = [
    [sequence("CV", 16, 21), "흉골정중선", /흉골정중선/],
    [sequence("CV", 2, 15), "복부 전정중선", /정중선/],
    [sequence("ST", 12, 18), "흉부 쇄골중선 · 유두 수직선", /유두|쇄골중선|유중|젖꼭지/],
    [sequence("ST", 19, 30), "복부 전정중선 옆 2촌선", /2촌/],
    [sequence("KI", 11, 21), "복부 전정중선 옆 0.5촌선", /0\.5촌/],
    [sequence("KI", 22, 27), "흉부 전정중선 옆 2촌선", /양방 2촌/],
    [sequence("SP", 12, 16), "복부 전정중선 옆 4촌선", /4촌/],
    [sequence("SP", 17, 20), "흉부 전정중선 옆 6촌선", /6촌/],
    [sequence("GV", 3, 14), "등·허리 후정중선", /후정중선/],
    [sequence("BL", 11, 26), "등·허리 배부 1측선 · 정중선 옆 1.5촌", /1\.5촌/],
    [sequence("BL", 41, 52), "등·허리 배부 2측선 · 정중선 옆 3촌", /3촌/],
    [["ST1", "ST2", "ST3"], "안면부 동공 수직선", /동공/],
    [["LU2", "LU1"], "운문·중부 수직선", /직상|직하/],
    [["PC4", "PC5", "PC6", "PC7"], "전완 앞쪽 손목횡문 정중의 세로선", /수근.*정중/],
    [["LR5", "LR6"], "하퇴 안쪽 경골후연", /경골후연/],
    [["KI9", "KI7", "KI3", "KI5"], "태계 직상·직하 취혈선", /태계.*직상|태계.*직하|내과첨과 근건/],
  ];
  for (const [ids, label, pattern] of verticalLines) {
    group("vertical", ids, label, "같은 부위에서 원문이 정의한 세로 취혈선입니다.", (id) => evidenceFrom(id, pattern));
  }
  const connectingLines = [
    [["LU3", "LU4", "LU5"], "상완 앞가쪽 · 액와횡문 전단–척택 연결선", "LU3", /천부혈과 협백혈.*척택혈/],
    [["LU5", "LU6", "LU7", "LU8", "LU9"], "전완 앞가쪽 · 척택–태연 연결선", "LU6", /척택혈과 태연혈의 연선/],
    [["LI5", "LI6", "LI7", "LI8", "LI9", "LI10", "LI11"], "전완 바깥쪽 · 양계–곡지 연결선", "LI6", /양계와 곡지의 연선/],
    [["LI11", "LI13", "LI14", "LI15"], "상완 바깥쪽 · 곡지–견우 연결선", "LI13", /곡지혈과 견우혈.*선상/],
    [["SI5", "SI7", "SI8"], "전완 뒤안쪽 · 양곡–소해 연결선", "SI7", /양곡혈과 소해혈의 연선/],
    [["ST31", "ST32", "ST33", "ST34"], "대퇴 앞가쪽 · 상전장골극–슬개골 외측상연 연결선", "ST32", /상전장골극.*선상/],
    [["HT3", "HT4", "HT5", "HT6", "HT7"], "전완 앞안쪽 · 신문에서 소해 방향", "HT4", /신문혈에서 소해를 향하여/],
    [["TE4", "TE5", "TE6", "TE8", "TE9"], "전완 뒤쪽 · 수근배측횡문 중앙의 세로선", "TE9", /수배측수근횡문의 중간/],
    [["BL36", "BL37", "BL40"], "대퇴 뒤쪽 · 승부–위중 연결선", "BL37", /승부혈과 위중혈의 중간/],
    [["HT1", "GB22", "SP21"], "측흉부 액와중앙선 · 극천–대포 연결선", "GB22", /극천.*대포혈.*선상/],
  ];
  for (const [ids, label, evidenceId, pattern] of connectingLines) {
    group("vertical", ids, label, "원문에 명시된 같은 부위의 종방향 취혈 연결선입니다.", (id) => evidenceFrom(id), [evidenceFrom(evidenceId, pattern)]);
  }

  // Explicitly named acupoints used in location/landmark descriptions. Match
  // whole Korean point names, retain the exact source sentence, and resolve
  // duplicate names only when a meridian qualifier or the source meridian
  // disambiguates them. Anatomy words such as 상완 are not point references.
  const nameCandidates = new Map();
  for (const point of sourcePoints) {
    for (const name of [point.name, ...(point.id === "GV26" ? ["인중"] : []), ...(point.id === "CV8" ? ["제중"] : [])]) {
      if (!nameCandidates.has(name)) nameCandidates.set(name, []);
      nameCandidates.get(name).push(point);
    }
  }
  const meridianTerms = {
    LU: "폐경", LI: "대장경", ST: "위경", SP: "비경", HT: "심경", SI: "소장경", BL: "방광경", KI: "신경",
    PC: "심포경", TE: "삼초경", GB: "담경", LR: "간경", CV: "임맥", GV: "독맥",
  };
  for (const point of sourcePoints) {
    for (const entry of fieldEntries(point)) {
      if (/혼동|병용|질환|적응증/.test(entry.text)) continue;
      if (entry.field === "note" && !/취혈|직상|직하|양방|외측|높이|촌|연결|선상|중간|위치/.test(entry.text)) continue;
      for (const [name, candidates] of nameCandidates) {
        const namePattern = new RegExp(`(^|[^가-힣]|의)${escaped(name)}(?=혈|[^가-힣]|에서|의|과|와|을|를|에|으로|직상|직하|상방|하방|양방|외측|내측|전방|후방|위로|밑|바깥|앞|뒤|옆|사이|$)`);
        if (!namePattern.test(entry.text)) continue;
        if (["상완", "전정", "기혈", "경골"].includes(name)
          && !new RegExp(`${escaped(name)}혈|${meridianTerms[candidates[0].code]}(?:의)?\\s*${escaped(name)}`).test(entry.text)) continue;
        if (name === "완골" && /유양돌기.*\(완골\)/.test(entry.text) && !/완골혈/.test(entry.text)) continue;
        let target;
        if (candidates.length === 1) target = candidates[0];
        else {
          const qualified = candidates.filter((candidate) => new RegExp(
            `${meridianTerms[candidate.code]}(?:의)?\\s*${escaped(name)}|${escaped(name)}(?:혈)?\\s*\\([^)]*${meridianTerms[candidate.code]}[^)]*\\)`,
          ).test(entry.text));
          target = qualified.length === 1 ? qualified[0] : candidates.find((candidate) => candidate.code === point.code);
        }
        if (!target || target.id === point.id) continue;
        add(point.id, "reference", target.id, `${target.name} 기준`, entry.text, [entry]);
      }
    }
  }
  for (const localization of result.values()) {
    if (localization.vertical.length <= VERTICAL_LIMIT) continue;
    const lines = [...new Set(localization.vertical.map((entry) => entry.label))]
      .map((label) => localization.vertical.filter((entry) => entry.label === label));
    const selected = [];
    for (let index = 0; selected.length < VERTICAL_LIMIT; index += 1) {
      const round = lines.flatMap((line) => line[index] ? [line[index]] : []);
      if (!round.length) break;
      selected.push(...round.slice(0, VERTICAL_LIMIT - selected.length));
    }
    localization.vertical = selected;
  }
  validateLocalizationRelations(result, sourcePoints);
  return result;
}

export function validateLocalizationRelations(pointsById, sourcePoints) {
  const source = new Map(sourcePoints.map((point) => [point.id, point]));
  const entries = pointsById instanceof Map ? pointsById.entries() : Object.entries(pointsById);
  for (const [id, pointOrLocalization] of entries) {
    const localization = pointOrLocalization.localization || pointOrLocalization;
    if (!source.has(id) || !localization || localization.evidencePolicy !== "source-text-only") throw new Error(`${id} is missing source-grounded localisation data.`);
    for (const category of CATEGORIES) {
      if (!Array.isArray(localization[category])) throw new Error(`${id} has no ${category} localisation list.`);
      const targets = new Set();
      for (const relation of localization[category]) {
        const target = source.get(relation.pointId);
        if (!target || relation.pointId === id || targets.has(relation.pointId)) throw new Error(`${id} has an invalid/duplicate ${category} target ${relation.pointId}.`);
        targets.add(relation.pointId);
        const expectedPolicy = MIDLINE_CODES.has(target.code) ? "midline" : "same-side";
        if (relation.instancePolicy !== expectedPolicy || !relation.label?.trim() || !relation.description?.trim() || !relation.evidence?.length) throw new Error(`${id}/${relation.pointId} has incomplete localisation evidence.`);
        for (const evidence of relation.evidence) {
          const evidencePoint = source.get(evidence.pointId);
          if (!evidencePoint || !fieldEntries(evidencePoint).some((entry) => entry.field === evidence.field && entry.text === evidence.text)) {
            throw new Error(`${id}/${relation.pointId} contains evidence absent from the source.`);
          }
        }
      }
      if (category === "vertical" && localization[category].length > VERTICAL_LIMIT) throw new Error(`${id} has too many vertical comparison markers.`);
    }
  }
}
