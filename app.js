const DATA_URL = "assets/json/meridians.json";
const QUESTION_LIMITS = [10, 25, 50];
const IMAGE_PRELOAD_LOOKAHEAD = 6;

const app = document.querySelector("#app");
const searchButton = document.querySelector("#searchButton");
const homeButton = document.querySelector("#homeButton");
const searchSheet = document.querySelector("#searchSheet");
const searchInput = document.querySelector("#searchInput");
const searchResults = document.querySelector("#searchResults");

let data = null;
let allPoints = [];
let meridianByCode = new Map();
let pointById = new Map();
let selectedMeridian = null;
let studyIndex = 0;
let questionLimit = 25;
let activeQuiz = null;
let feedbackTimer = null;
let imageLongPressTimer = null;
let suppressImageChoiceClick = false;
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

  searchSheet.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-search]")) closeSearch();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (closeImagePreview()) return;
      if (!searchSheet.hidden) closeSearch();
    }
  });

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-close-image-preview]")) closeImagePreview();
  });
}

function decorateData() {
  meridianByCode = new Map();
  pointById = new Map();

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
  if (!button) return;

  const action = button.dataset.action;
  const code = button.dataset.code;
  const menu = button.dataset.menu;
  const id = button.dataset.id;

  if (action === "select-meridian") {
    selectedMeridian = meridianByCode.get(code);
    renderMenu();
  }

  if (action === "back-home") renderHome();
  if (action === "back-menu") renderMenu();

  if (action === "set-limit") {
    questionLimit = Number(button.dataset.count);
    renderMenu();
  }

  if (action === "start-menu") {
    if (menu === "study") {
      startStudy(selectedMeridian.code);
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

  app.innerHTML = `
    <section class="screen">
      <div class="screen-heading">
        <p class="kicker">14개 단원</p>
        <h2>단원을 고르세요</h2>
      </div>
      <div class="unit-grid">
        ${data.meridians
          .map(
            (meridian) => `
              <button class="unit-card" type="button" data-action="select-meridian" data-code="${escapeHtml(meridian.code)}">
                <strong>${escapeHtml(meridian.name)}</strong>
                <span>${meridian.points.length}혈</span>
              </button>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
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

function menuCard(id, title, detail) {
  return `
    <button class="menu-card" type="button" data-action="start-menu" data-menu="${id}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </button>
  `;
}

function startStudy(code, pointId = null) {
  clearFeedbackTimer();
  activeQuiz = null;
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
        <button class="text-button secondary" type="button" data-action="back-menu">메뉴</button>
        <button class="study-nav-button" type="button" data-action="study-prev" ${studyIndex === 0 ? "disabled" : ""}>이전</button>
        <span class="progress-pill">${studyIndex + 1} / ${selectedMeridian.points.length}</span>
        <button class="study-nav-button" type="button" data-action="study-next" ${studyIndex === selectedMeridian.points.length - 1 ? "disabled" : ""}>다음</button>
      </div>

      <div class="point-title">
        <p class="kicker">${escapeHtml(selectedMeridian.name)}</p>
        <h2>${escapeHtml(point.name)}</h2>
      </div>

      <figure class="image-panel">
        <img src="${escapeHtml(point.image)}" alt="${escapeHtml(point.name)} 위치 이미지" />
      </figure>

      ${infoBlock("위치", point.location)}
      ${infoBlock("취혈요령", point.technique)}
    </section>
  `;

  preloadUpcomingStudyImages(studyIndex + 1);
}

function infoBlock(title, items) {
  const list = items.length
    ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")
    : `<li>등록된 내용 없음</li>`;

  return `
    <section class="info-block">
      <h3>${escapeHtml(title)}</h3>
      <ul class="info-list">${list}</ul>
    </section>
  `;
}

function startQuiz(menuId) {
  clearFeedbackTimer();
  const config = createQuizConfig(menuId);
  activeQuiz = {
    ...config,
    menuId,
    questions: buildQuestions(config),
    index: 0,
    correct: 0,
    wrong: [],
    locked: false,
    feedback: null,
  };

  renderQuiz();
}

function createQuizConfig(menuId) {
  const unitPoints = selectedMeridian.points;
  const cumulativePoints = data.meridians
    .filter((meridian) => meridian.order <= selectedMeridian.order)
    .flatMap((meridian) => meridian.points);

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

function buildQuestions(config) {
  const answers = config.ordered
    ? [...config.questionPool]
    : takeRepeatedShuffle(config.questionPool, config.count);

  return answers.map((answer) => ({
    answerId: answer.id,
    choices: buildChoices(answer, config).map((point) => point.id),
  }));
}

function buildChoices(answer, config) {
  const desiredCount = 1 + config.sameChoices + config.otherChoices;
  const selected = new Map([[answer.id, answer]]);

  const addFromPool = (pool, count) => {
    let added = 0;
    for (const point of shuffle(pool)) {
      if (added >= count) break;
      if (point.id === answer.id || selected.has(point.id)) continue;
      selected.set(point.id, point);
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
    renderMenu();
    return;
  }

  if (activeQuiz.index >= activeQuiz.questions.length) {
    renderResult();
    return;
  }

  const question = activeQuiz.questions[activeQuiz.index];
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
      data-preview-alt="${escapeHtml(choice.name)} 위치 이미지"
      data-preview-title="${escapeHtml(choice.name)}"
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
      title: choice.dataset.previewTitle,
    });
  }, IMAGE_LONG_PRESS_DELAY);
}

function clearImageLongPressTimer() {
  if (!imageLongPressTimer) return;
  clearTimeout(imageLongPressTimer);
  imageLongPressTimer = null;
}

function showImagePreview({ src, alt, title }) {
  clearImageLongPressTimer();
  if (!src) return;

  closeImagePreview();
  const preview = document.createElement("div");
  preview.className = "image-preview";
  preview.dataset.closeImagePreview = "";
  preview.innerHTML = `
    <figure class="image-preview-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title || "경혈 위치 이미지 확대")}">
      <button class="image-preview-close" type="button" data-close-image-preview aria-label="확대 이미지 닫기">×</button>
      <img src="${escapeHtml(src)}" alt="${escapeHtml(alt || "경혈 위치 이미지 확대")}" />
      ${title ? `<figcaption>${escapeHtml(title)}</figcaption>` : ""}
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

  const isAnswer = choice.id === answer.id;
  const isSelected = choice.id === activeQuiz.feedback.selectedId;

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

function handleAnswer(selectedId) {
  if (!activeQuiz || activeQuiz.locked) return;

  const question = activeQuiz.questions[activeQuiz.index];
  const correct = selectedId === question.answerId;

  activeQuiz.locked = true;
  activeQuiz.feedback = { selectedId, correct };

  if (correct) {
    activeQuiz.correct += 1;
  } else {
    activeQuiz.wrong.push({
      answerId: question.answerId,
      selectedId,
      promptType: activeQuiz.promptType,
      choiceType: activeQuiz.choiceType,
    });
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

function renderResult() {
  const total = activeQuiz.questions.length;
  const score = Math.round((activeQuiz.correct / total) * 100);
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
        ${activeQuiz.wrong.map(renderWrongItem).join("")}
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
    .filter((point) => normalizeText(point.name).includes(keyword))
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
  closeSearch();
  startStudy(point.code, point.id);
}

function takeRepeatedShuffle(pool, count) {
  const result = [];
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
