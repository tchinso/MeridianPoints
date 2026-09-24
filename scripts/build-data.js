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

// 위치와 취혈요령에서 자주 쓰이는 전문 용어를 학습 중 바로 확인할 수 있게 한다.
// 긴 표현을 먼저 등록해 "상완 전외측"처럼 의미가 하나인 말이 낱말로 쪼개지지 않게 한다.
const TERM_GLOSSARY = {
  "상완 전외측": "위팔(어깨부터 팔꿈치 사이)의 앞쪽 바깥면",
  "상완 전내측": "위팔(어깨부터 팔꿈치 사이)의 앞쪽 안쪽면",
  "상완 외측": "위팔(어깨부터 팔꿈치 사이)의 바깥쪽",
  "상완 내측": "위팔(어깨부터 팔꿈치 사이)의 안쪽",
  "대퇴 전외측": "허벅지의 앞쪽 바깥면",
  "대퇴 전내측": "허벅지의 앞쪽 안쪽면",
  "대퇴 외측": "허벅지의 바깥쪽",
  "대퇴 내측": "허벅지의 안쪽",
  "대퇴 후측": "허벅지의 뒤쪽",
  "하퇴 전외측": "종아리의 앞쪽 바깥면",
  "하퇴 전내측": "종아리의 앞쪽 안쪽면",
  "하퇴 후외측": "종아리의 뒤쪽 바깥면",
  "하퇴 후내측": "종아리의 뒤쪽 안쪽면",
  "하퇴 외측": "종아리의 바깥쪽",
  "하퇴 내측": "종아리의 안쪽",
  "하퇴 후측": "종아리의 뒤쪽",
  "전완 전외측": "아래팔(팔꿈치부터 손목 사이)의 앞쪽 바깥면",
  "전완 전내측": "아래팔(팔꿈치부터 손목 사이)의 앞쪽 안쪽면",
  "액와횡문 전단": "겨드랑이 앞쪽 끝에 있는 가로주름의 끝부분",
  "액와후횡문단": "겨드랑이 뒤쪽 가로주름의 끝부분",
  "주와횡문 전외측": "팔꿈치를 굽혔을 때 앞쪽에 생기는 주름의 바깥쪽",
  "상완이두근 외연": "위팔 앞쪽 근육(상완이두근)의 바깥 가장자리",
  "상완이두근 내측": "위팔 앞쪽 근육(상완이두근)의 안쪽",
  "상완이두근 외측": "위팔 앞쪽 근육(상완이두근)의 바깥쪽",
  "상완이두근의 장두와 단두 사이": "위팔 앞쪽 근육이 두 갈래로 나뉘는 사이",
  "상완이두근건": "위팔 앞쪽 근육이 팔꿈치 쪽에서 힘줄로 이어진 부분",
  "상완골외측상과": "팔꿈치 바깥쪽에서 만져지는 위팔뼈의 튀어나온 부분",
  "상완골내측상과": "팔꿈치 안쪽에서 만져지는 위팔뼈의 튀어나온 부분",
  "흉골정중선": "가슴뼈 한가운데를 따라 내려가는 세로선",
  "전정중선": "몸 앞면 한가운데를 따라 내려가는 세로선",
  "후정중선": "몸 뒷면 한가운데를 따라 내려가는 세로선",
  "전흉부": "가슴의 앞쪽 부위",
  "상복부": "배꼽보다 위쪽의 배 부위",
  "하복부": "배꼽보다 아래쪽의 배 부위",
  "측흉부": "가슴의 옆쪽 부위",
  "측복부": "배의 옆쪽 부위",
  "전경부": "목의 앞쪽 부위",
  "후경부": "목의 뒤쪽 부위",
  "측경부": "목의 옆쪽 부위",
  "전두부": "이마 부위",
  "두정부": "머리의 가장 윗부분",
  "후두부": "뒤통수 부위",
  "측두부": "관자놀이 부위",
  "안면부": "얼굴 부위",
  "배부": "등 부위",
  "요부": "허리 부위",
  "천골부": "엉치뼈가 있는 부위",
  "둔부": "엉덩이 부위",
  "회음부": "성기와 항문 사이의 부위",
  "중액와선": "겨드랑이 한가운데를 수직으로 잇는 선",
  "쇄골외단": "내 가슴뼈 쪽이 아니라, 어깨와 만나는 바깥쪽 쇄골 끝부분",
  "쇄골하와": "쇄골 바로 아래에 오목하게 들어간 부위",
  "쇄골하연": "쇄골의 아래쪽 모서리",
  "쇄골상와": "쇄골 바로 위에 오목하게 들어간 부위",
  "흉쇄유돌근": "고개를 돌리면 목 옆으로 도드라지는 굵은 근육",
  "요골경상돌기": "엄지손가락 쪽 손목에서 만져지는 뼈 돌출부",
  "장무지굴근건": "엄지를 굽히는 근육이 손목에서 힘줄로 이어진 부분",
  "주와횡문": "팔꿈치를 굽혔을 때 앞쪽에 생기는 가로주름",
  "주와 횡문": "팔꿈치를 굽혔을 때 앞쪽에 생기는 가로주름",
  "주관절": "팔꿈치 관절",
  "주두": "팔꿈치 뒤쪽에서 만져지는 뾰족한 뼈 끝",
  "주횡문": "팔꿈치를 굽혔을 때 생기는 가로주름",
  "완횡문": "손목을 굽혔을 때 생기는 가로주름",
  "수근횡문": "손목을 굽혔을 때 생기는 가로주름",
  "배측 수근횡문": "손등 쪽 손목에 생기는 가로주름",
  "수근배측횡문": "손등 쪽 손목에 생기는 가로주름",
  "수배척측": "손등의 새끼손가락 쪽",
  "수배측": "손등 쪽",
  "장측": "손바닥 쪽",
  "요측": "엄지손가락이 있는 쪽",
  "척측": "새끼손가락이 있는 쪽",
  "지갑각": "손발톱의 양쪽 모서리",
  "적백육제": "손바닥·발바닥의 붉은 살과 손등·발등의 흰 살이 만나는 경계",
  "제1중수골": "엄지손가락으로 이어지는 손등뼈",
  "제2중수골": "둘째손가락으로 이어지는 손등뼈",
  "제1중족골": "엄지발가락으로 이어지는 발등뼈",
  "제2중족골": "둘째발가락으로 이어지는 발등뼈",
  "중수지절관절": "손가락과 손등뼈가 만나는 관절, 주먹 쥘 때 도드라지는 마디",
  "중족지절관절": "발가락과 발등뼈가 만나는 관절",
  "중족골저": "발등뼈가 발목뼈와 만나는 쪽의 끝부분",
  "중수골두": "손등뼈에서 손가락과 만나는 둥근 끝부분",
  "중족골두": "발등뼈에서 발가락과 만나는 둥근 끝부분",
  "족관절": "발목 관절",
  "족무지": "엄지발가락",
  "족지": "발가락",
  "늑골궁": "갈비뼈 아래쪽이 활처럼 만나는 가장자리",
  "제1늑간": "첫째와 둘째 갈비뼈 사이",
  "늑간": "갈비뼈와 갈비뼈 사이",
  "흉늑각": "가슴뼈 아래쪽에서 양쪽 갈비뼈가 이루는 각도",
  "견봉돌기": "어깨 가장 위에서 만져지는 뼈 돌출부",
  "견갑골극": "등쪽 견갑뼈에서 가로로 만져지는 뼈 능선",
  "견관절": "어깨 관절",
  "삼각근": "어깨를 덮고 있는 둥근 모양의 큰 근육",
  "승모근": "목과 어깨, 등 윗부분을 넓게 덮는 근육",
  "비복근": "종아리 뒤쪽에서 볼록하게 만져지는 근육",
  "장경인대": "허벅지 바깥쪽을 따라 무릎까지 이어지는 단단한 띠 모양 조직",
  "아킬레스건": "종아리 근육과 발뒤꿈치를 잇는 굵은 힘줄",
  "오훼돌기": "쇄골 아래쪽에서 만져지는 갈고리 모양의 견갑뼈 돌출부",
  "후두융기": "목 뒤 중앙에서 만져지는 튀어나온 뼈",
  "외후두융기": "뒤통수 아래 가운데에서 만져지는 튀어나온 뼈",
  "유양돌기": "귀 뒤아래에서 만져지는 뼈 돌출부",
  "하악각": "아래턱뼈 뒤쪽의 모서리",
  "갑상연골": "목 앞쪽의 울대뼈",
  "비순구": "코 옆에서 입꼬리까지 이어지는 고랑",
  "비하구": "코와 윗입술 사이의 세로 홈",
  "비익": "콧구멍 양옆의 도톰한 콧방울",
  "안와": "눈알을 둘러싼 뼈 공간",
  "안와상절흔": "눈썹뼈 아래에서 만져지는 작은 패임",
  "안와하연": "눈을 둘러싼 뼈 공간의 아래쪽 가장자리",
  "내안각": "눈의 안쪽 모서리",
  "외안각": "눈의 바깥쪽 모서리",
  "협골궁": "광대뼈에서 옆으로 활처럼 이어지는 뼈 부분",
  "이주": "귓구멍 앞쪽에 튀어나온 작은 연골",
  "이개": "눈에 보이는 바깥귀 전체",
  "이첨": "귀의 가장 높은 끝부분",
  "이륜": "바깥귀 가장자리를 따라 둥글게 이어지는 연골",
  "이수": "귓불",
  "치골결합": "아랫배 중앙에서 좌우 골반뼈가 만나는 부위",
  "치골릉": "치골 위쪽에서 만져지는 능선",
  "서혜부": "아랫배와 허벅지가 만나는 접히는 부위",
  "슬와횡문": "무릎을 굽혔을 때 오금에 생기는 가로주름",
  "슬와부": "무릎 뒤쪽의 오금 부위",
  "슬개골": "무릎 앞쪽의 동그란 뼈",
  "슬개인대": "무릎뼈 아래에서 정강이뼈로 이어지는 힘줄",
  "경골": "종아리 앞안쪽의 굵은 뼈, 정강이뼈",
  "비골": "종아리 바깥쪽의 가는 뼈",
  "내과": "발목 안쪽의 복사뼈",
  "외과": "발목 바깥쪽의 복사뼈",
  "종골": "발뒤꿈치뼈",
  "비골두": "종아리 바깥쪽 뼈의 윗부분에서 만져지는 돌출부",
  "대전자": "허벅지뼈 바깥 위쪽에서 만져지는 큰 돌출부",
  "상전장골극": "골반 앞쪽 위에서 만져지는 뾰족한 뼈 돌출부",
  "장골릉": "골반뼈의 위쪽 가장자리",
  "천골열공": "엉치뼈 아래쪽 가운데의 작은 틈",
  "후천골공": "엉치뼈 뒤쪽에 좌우로 나 있는 구멍",
  "정중천골릉": "엉치뼈 가운데를 세로로 따라 만져지는 뼈 능선",
  "족배": "발등 쪽",
  "족저": "발바닥 쪽",
  "함요처": "쏙 들어간 자리",
  "함요부": "쏙 들어간 부위",
  "함요": "쏙 들어간 자리",
  "외연": "바깥 가장자리",
  "내연": "안쪽 가장자리",
  "전외측": "앞쪽 바깥면",
  "전내측": "앞쪽 안쪽면",
  "후외측": "뒤쪽 바깥면",
  "후내측": "뒤쪽 안쪽면",
  "외측": "몸의 바깥쪽",
  "내측": "몸의 안쪽",
  "전단": "앞쪽 끝부분",
  "후단": "뒤쪽 끝부분",
  "상연": "위쪽 모서리",
  "하연": "아래쪽 모서리",
  "직상": "바로 위쪽",
  "직하": "바로 아래쪽",
  "상방": "위쪽 방향",
  "하방": "아래쪽 방향",
  "앙와위": "바로 누운 자세",
  "복와위": "엎드려 누운 자세",
  "좌위": "앉은 자세",
  "굴주": "팔꿈치를 굽힌 자세",
  "굴슬": "무릎을 굽힌 자세",
  "악권": "주먹을 쥔 상태",
  "앙장시": "손바닥이 위를 향한 상태",
  "부장시": "손바닥이 아래를 향한 상태",
  "거비": "팔을 들어 올리는 동작",
  "동신촌법": "본인 손가락 너비를 기준으로 길이를 재는 방법",
  "골도법": "뼈의 기준점 사이를 정해진 촌수로 나눠 재는 방법",
  "일횡지": "본인 손가락 한 마디 폭을 기준으로 재는 길이",
  "횡지": "손가락을 가로로 댄 너비를 기준으로 재는 길이",
  "촌": "몸의 비례를 사용해 재는 한의학 길이 단위",
  "푼": "1촌의 10분의 1",
  "양방": "정중선을 기준으로 좌우 같은 거리",
  "상평": "같은 높이",
  "연선상": "두 기준점을 이은 선 위",
  "제부": "배꼽 부위",
  "제중": "배꼽의 한가운데",
  "유선": "젖꼭지를 지나는 세로선",
  "발제": "머리카락이 시작되는 경계선",
  "전발제": "이마 쪽 머리카락이 시작되는 선",
  "후발제": "목덜미 쪽 머리카락이 시작되는 선",
  "조갑": "손톱 또는 발톱",
  "조갑 발생근부": "손발톱이 피부에서 시작되는 뿌리 쪽",
  "무지": "엄지손가락",
  "시지": "둘째손가락",
};

// HanbangText.txt와 대조해, 오기 때문에 뜻을 알기 어려운 표현만 바로잡는다.
// 나머지 설명은 기존 학생 프린트 원문을 유지한다.
const CLARITY_OVERRIDES = {
  LU10: {
    location: ["엄지손가락 아래 도톰한 부위의 바깥쪽, 첫째 손등뼈 가운데의 바깥쪽(손바닥과 손등 피부 경계)"],
  },
  LU3: {
    location: ["상완 전외측으로 액와횡문 전단의 하측 3촌, 상완이두근 외연"],
    technique: ["천부혈과 협백혈은 액와횡문 전단과 척택혈(주와횡문 전외측)의 연결선을 9촌으로 나눠 취혈한다."],
  },
  LI4: {
    location: ["손등에서 둘째 손등뼈 가운데의 엄지손가락 쪽"],
  },
  LI14: {
    location: ["위팔 바깥쪽에서 견우혈 아래 3촌, 삼각근이 끝나는 부위의 앞 가장자리"],
  },
  HT4: {
    location: ["아래팔 앞안쪽에서 신문혈 위 1.5촌, 새끼손가락 쪽 손목 굽힘 힘줄의 바깥쪽"],
  },
  SI2: {
    location: ["새끼손가락 쪽에서 다섯째 손가락 관절의 아래안쪽 오목한 자리(손바닥과 손등 피부 경계)"],
  },
  SI3: {
    location: ["새끼손가락 쪽 손등에서 다섯째 손가락 관절의 위안쪽 오목한 자리(손바닥과 손등 피부 경계)"],
  },
  SI6: {
    location: ["아래팔 뒤안쪽에서 손등 쪽 손목 주름 위 1촌, 자뼈 끝의 엄지손가락 쪽에 만져지는 틈"],
  },
  SI18: {
    location: ["광대뼈 아래쪽 가운데, 입꼬리 옆의 영향혈과 같은 높이에서 눈 바깥쪽 모서리 바로 아래"],
  },
  PC2: {
    location: ["액와횡문 전단의 하측 2촌, 상완이두근의 장두와 단두 사이, 상완이두근 안쪽"],
    technique: ["액와횡문 전단과 곡택혈(주와횡문 전외측)을 잇는 선(9촌)에서, 곡택혈을 향해 아래로 2촌 내려간 곳이 천천이다."],
  },
  PC3: {
    location: ["팔꿈치를 굽혔을 때 팔꿈치 앞쪽 주름 위, 위팔 앞쪽 힘줄의 안쪽 오목한 자리"],
  },
  TE3: {
    location: ["손등에서 넷째와 다섯째 손등뼈 사이, 넷째 손가락 관절 바로 뒤의 오목한 자리"],
  },
  TE4: {
    location: ["손등 쪽 손목 주름 한가운데, 넷째와 다섯째 손등뼈 사이의 오목한 자리"],
  },
  TE9: {
    location: ["아래팔 뒤쪽에서 팔꿈치 끝 아래 5촌, 두 아래팔뼈 사이의 가운데"],
  },
  TE19: {
    location: ["귀 아래 뒤쪽의 예풍혈과 귀 위쪽의 각손혈을 잇는 곡선에서 위쪽 1/3 지점"],
  },
  TE20: {
    location: ["귀를 앞으로 반쯤 접어 머리에 붙였을 때, 귀 끝이 닿는 자리"],
  },
  GB2: {
    location: ["입을 벌리면 귓구멍 앞쪽 아래의 오목한 자리"],
  },
  GB3: {
    location: ["광대뼈 활의 위쪽 가운데, 하관혈 바로 위 오목한 자리"],
  },
  GB29: {
    location: ["엉덩이 옆에서 앞위엉덩뼈와 넓적다리뼈 큰 돌출부를 이은 선의 중간"],
  },
  GB30: {
    location: ["엉덩이에서 넓적다리뼈 큰 돌출부와 천골열공을 잇는 선의 바깥쪽 1/3 지점"],
  },
  GB33: {
    location: ["무릎 바깥쪽에서 넓적다리뼈 바깥 돌출부의 뒤위, 두 힘줄 사이 오목한 자리"],
  },
  GB35: {
    location: ["종아리 바깥쪽에서 바깥 복사뼈 위 7촌, 종아리뼈 뒤쪽 가장자리"],
  },
  GB39: {
    location: ["종아리 바깥쪽에서 바깥 복사뼈 위 3촌, 종아리뼈 앞쪽 가장자리"],
  },
  GB41: {
    location: ["발등에서 넷째·다섯째 발등뼈가 만나는 곳의 앞쪽 오목한 자리"],
  },
  GB42: {
    location: ["발등에서 넷째 발가락 관절 바로 뒤 바깥쪽 오목한 자리"],
  },
  GB43: {
    location: ["발등에서 넷째·다섯째 발가락 사이의 오목한 자리(피부 색이 바뀌는 경계)"],
  },
  LR1: {
    location: ["엄지발가락 바깥쪽 손톱 모서리에서 뒤로 0.1촌"],
  },
  LR2: {
    location: ["발등에서 엄지발가락과 둘째발가락 사이의 오목한 자리(피부 색이 바뀌는 경계)"],
  },
  LR3: {
    location: ["발등에서 첫째·둘째 발등뼈가 만나는 곳의 앞쪽 오목한 자리"],
  },
  LR11: {
    location: ["허벅지 위쪽 안쪽에서 기충혈 아래 2촌"],
  },
  LR13: {
    location: ["옆구리에서 열한째 갈비뼈 끝 아래"],
  },
  CV1: {
    location: ["회음부 중앙: 남성은 항문과 음낭 뒤쪽 사이, 여성은 항문과 외음부 뒤쪽 사이"],
  },
  CV23: {
    location: ["목 앞 가운데, 목뿔뼈 바로 위의 오목한 자리"],
  },
  GV17: {
    location: ["뒷머리 가운데, 뒤통수뼈 튀어나온 부분의 위쪽 오목한 자리"],
  },
  GV27: {
    location: ["윗입술 가운데의 도톰한 부분과 인중 아래가 만나는 곳"],
  },
};

const TEXT_CLARITY_REPLACEMENTS = [
  ["전비내측 즉 앞팔 안쪽", "아래팔 앞쪽 바깥면"],
  ["전액 횡문단", "액와횡문 전단"],
  ["전액횡문두", "액와횡문 전단"],
  ["전액횡문단", "액와횡문 전단"],
  ["완굴슬시에", "무릎을 완전히 굽힌 자세에서"],
  ["이곳은 권골궁과 하악절흔과의 사이에 생기는 함요부이다.", "이곳은 광대뼈 활과 아래턱뼈 패임 사이의 오목한 자리이다."],
  ["전비가 상완이두근에 닿게 팔꿈치를 구부려", "아래팔이 위팔 앞쪽 근육에 닿도록 팔꿈치를 구부려"],
  ["이 뼈가 권골궁이며 바로 하관 직상방 권골궁상연의 함요처가 바로 상관이다.", "이 뼈가 광대뼈 활이며, 바로 하관혈 위쪽의 오목한 자리가 상관이다."],
  ["제4∼5발가락 봉단에서 위로 5푼 가량이 봉단이라고도 한다.", "넷째·다섯째 발가락이 붙는 경계에서 위로 약 5푼 되는 곳이다."],
  ["후두부의 침골외후두융기상연 두부정중선상에서 취혈한다.", "뒷머리 가운데, 외후두융기 위쪽의 오목한 자리에서 취혈한다."],
];

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

function applyClarityOverrides(meridians) {
  const points = meridians.flatMap((meridian) => meridian.points);

  for (const point of points) {
    for (const field of ["location", "technique"]) {
      point[field] = point[field].map((text) => {
        let corrected = text;
        for (const [from, to] of TEXT_CLARITY_REPLACEMENTS) {
          corrected = corrected.replaceAll(from, to);
        }
        return corrected;
      });
    }
  }

  for (const [pointId, override] of Object.entries(CLARITY_OVERRIDES)) {
    const point = points.find((candidate) => candidate.id === pointId);
    if (!point) continue;

    for (const field of ["location", "technique"]) {
      if (override[field]) point[field] = override[field];
    }
  }
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
  const points = meridians.flatMap((meridian) => meridian.points);
  const li19 = points.find((point) => point.id === "LI19");
  const te22 = points.find((point) => point.id === "TE22");
  // HanbangText.txt's 구화료(LI19)·이화료(TE22) match LocationAndIndications.txt's 화료 entries.
  if (li19) li19.aliases = ["구화료"];
  if (te22) te22.aliases = ["이화료"];
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
applyClarityOverrides(meridians);
const orderedMeridians = reorderMeridians(meridians);
applyPointAliases(orderedMeridians);
const important = parseImportantData(importantSource, orderedMeridians);
const validationWarnings = validate(orderedMeridians);
const totalPoints = orderedMeridians.reduce((sum, meridian) => sum + meridian.points.length, 0);

const data = {
  version: 3,
  sourceFiles: [
    "assets/references/MeridianPoints.txt",
    "assets/references/LocationAndIndications.txt",
    "assets/references/ImportantMeridianPoints.txt",
  ],
  clarityReview: {
    reference: "assets/references/HanbangText.txt",
    reviewedPointCount: 361,
    referenceEntryCount: 360,
    referenceEntryMissing: ["BL63"],
  },
  totalPoints,
  termGlossary: TERM_GLOSSARY,
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
