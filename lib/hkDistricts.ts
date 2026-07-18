/**
 * Hong Kong's 18 official districts, with approximate centroids.
 *
 * This is public geographic fact, hardcoded deliberately. The app does NOT hold
 * a store/dealer database — comparison results are attributed links from
 * grounded search, and this table exists only to answer "which district am I
 * in?" and to sort results by rough proximity.
 *
 * Centroids are good to a kilometre or so, which is all district-level sorting
 * needs. They are not branch-accurate and must not be presented as such.
 */

export interface District {
  /** Stable key used in the database and query strings. */
  id: string;
  en: string;
  zh: string;
  region: "Hong Kong Island" | "Kowloon" | "New Territories";
  lat: number;
  lng: number;
}

export const HK_DISTRICTS: District[] = [
  // Hong Kong Island
  { id: "central-western", en: "Central & Western", zh: "中西區", region: "Hong Kong Island", lat: 22.287, lng: 114.154 },
  { id: "wan-chai", en: "Wan Chai", zh: "灣仔區", region: "Hong Kong Island", lat: 22.276, lng: 114.175 },
  { id: "eastern", en: "Eastern", zh: "東區", region: "Hong Kong Island", lat: 22.283, lng: 114.224 },
  { id: "southern", en: "Southern", zh: "南區", region: "Hong Kong Island", lat: 22.247, lng: 114.159 },

  // Kowloon
  { id: "yau-tsim-mong", en: "Yau Tsim Mong", zh: "油尖旺區", region: "Kowloon", lat: 22.305, lng: 114.17 },
  { id: "sham-shui-po", en: "Sham Shui Po", zh: "深水埗區", region: "Kowloon", lat: 22.33, lng: 114.162 },
  { id: "kowloon-city", en: "Kowloon City", zh: "九龍城區", region: "Kowloon", lat: 22.328, lng: 114.191 },
  { id: "wong-tai-sin", en: "Wong Tai Sin", zh: "黃大仙區", region: "Kowloon", lat: 22.342, lng: 114.194 },
  { id: "kwun-tong", en: "Kwun Tong", zh: "觀塘區", region: "Kowloon", lat: 22.313, lng: 114.226 },

  // New Territories
  { id: "kwai-tsing", en: "Kwai Tsing", zh: "葵青區", region: "New Territories", lat: 22.356, lng: 114.13 },
  { id: "tsuen-wan", en: "Tsuen Wan", zh: "荃灣區", region: "New Territories", lat: 22.371, lng: 114.114 },
  { id: "tuen-mun", en: "Tuen Mun", zh: "屯門區", region: "New Territories", lat: 22.391, lng: 113.977 },
  { id: "yuen-long", en: "Yuen Long", zh: "元朗區", region: "New Territories", lat: 22.445, lng: 114.022 },
  { id: "north", en: "North", zh: "北區", region: "New Territories", lat: 22.494, lng: 114.138 },
  { id: "tai-po", en: "Tai Po", zh: "大埔區", region: "New Territories", lat: 22.45, lng: 114.164 },
  { id: "sha-tin", en: "Sha Tin", zh: "沙田區", region: "New Territories", lat: 22.383, lng: 114.189 },
  { id: "sai-kung", en: "Sai Kung", zh: "西貢區", region: "New Territories", lat: 22.381, lng: 114.271 },
  { id: "islands", en: "Islands", zh: "離島區", region: "New Territories", lat: 22.261, lng: 113.946 },
];

export function districtById(id: string): District | undefined {
  return HK_DISTRICTS.find((d) => d.id === id);
}

/** Great-circle distance in km. */
export function distanceKm(
  aLat: number,
  aLng: number,
  bLat: number,
  bLng: number,
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Nearest district to a coordinate.
 *
 * Returns null when the point is far outside Hong Kong, so a user abroad gets
 * "set your district manually" rather than a confidently wrong answer.
 */
export function nearestDistrict(lat: number, lng: number): District | null {
  let best: District | null = null;
  let bestKm = Infinity;
  for (const d of HK_DISTRICTS) {
    const km = distanceKm(lat, lng, d.lat, d.lng);
    if (km < bestKm) {
      bestKm = km;
      best = d;
    }
  }
  return bestKm <= 50 ? best : null;
}

/**
 * Best-effort mapping of free text (a store address or area name returned by
 * search) to a district. Returns "" when nothing matches — callers must treat
 * that as "unknown", never as a default district.
 */
// Common area names that don't contain their district's own name. Module-level
// so the fuzzy fallback can reuse them.
const AREA_HINTS: Record<string, string> = {
    "mong kok": "yau-tsim-mong",
    mongkok: "yau-tsim-mong",
    "tsim sha tsui": "yau-tsim-mong",
    tst: "yau-tsim-mong",
    jordan: "yau-tsim-mong",
    "yau ma tei": "yau-tsim-mong",
    central: "central-western",
    "sheung wan": "central-western",
    admiralty: "central-western",
    "causeway bay": "wan-chai",
    "happy valley": "wan-chai",
    "north point": "eastern",
    quarry: "eastern",
    "tai koo": "eastern",
    aberdeen: "southern",
    "ap lei chau": "southern",
    "golden computer": "sham-shui-po",
    "cheung sha wan": "sham-shui-po",
    "kowloon tong": "kowloon-city",
    "hung hom": "kowloon-city",
    "to kwa wan": "kowloon-city",
    "diamond hill": "wong-tai-sin",
    "ngau tau kok": "kwun-tong",
    "kowloon bay": "kwun-tong",
    "lam tin": "kwun-tong",
    "kwai chung": "kwai-tsing",
    tsingyi: "kwai-tsing",
    "tsing yi": "kwai-tsing",
    "tsuen wan": "tsuen-wan",
    "tin shui wai": "yuen-long",
    "sheung shui": "north",
    fanling: "north",
    "ma on shan": "sha-tin",
    "tseung kwan o": "sai-kung",
    tko: "sai-kung",
  "tung chung": "islands",

  // Chinese area names. HK shelf tags are frequently Chinese-only, and these
  // are matched exactly (toLowerCase is a no-op on Han characters, and the
  // fuzzy pass skips them since it works on latin letters).
  旺角: "yau-tsim-mong",
  尖沙咀: "yau-tsim-mong",
  油麻地: "yau-tsim-mong",
  佐敦: "yau-tsim-mong",
  中環: "central-western",
  上環: "central-western",
  金鐘: "central-western",
  西環: "central-western",
  銅鑼灣: "wan-chai",
  灣仔: "wan-chai",
  跑馬地: "wan-chai",
  北角: "eastern",
  太古: "eastern",
  鰂魚涌: "eastern",
  筲箕灣: "eastern",
  香港仔: "southern",
  鴨脷洲: "southern",
  深水埗: "sham-shui-po",
  長沙灣: "sham-shui-po",
  九龍城: "kowloon-city",
  紅磡: "kowloon-city",
  九龍塘: "kowloon-city",
  土瓜灣: "kowloon-city",
  黃大仙: "wong-tai-sin",
  鑽石山: "wong-tai-sin",
  觀塘: "kwun-tong",
  牛頭角: "kwun-tong",
  九龍灣: "kwun-tong",
  藍田: "kwun-tong",
  葵涌: "kwai-tsing",
  青衣: "kwai-tsing",
  荃灣: "tsuen-wan",
  屯門: "tuen-mun",
  元朗: "yuen-long",
  天水圍: "yuen-long",
  上水: "north",
  粉嶺: "north",
  大埔: "tai-po",
  沙田: "sha-tin",
  馬鞍山: "sha-tin",
  西貢: "sai-kung",
  將軍澳: "sai-kung",
  東涌: "islands",
};

export function districtFromText(text: string): string {
  if (!text) return "";
  const hay = text.toLowerCase();

  for (const [needle, id] of Object.entries(AREA_HINTS)) {
    if (hay.includes(needle)) return id;
  }

  for (const d of HK_DISTRICTS) {
    if (hay.includes(d.en.toLowerCase()) || text.includes(d.zh)) return d.id;
  }

  // Fall back to a tolerant match. Place names read off a photo are routinely
  // mis-transcribed by a character or two ("Mong Kok" → "Mong Kong"), which
  // defeats exact matching. The threshold is deliberately tight: naming the
  // wrong district is worse than admitting we don't know.
  return fuzzyDistrict(hay);
}

/** Levenshtein distance, iterative two-row. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");

function fuzzyDistrict(hay: string): string {
  const candidates: [string, string][] = [
    ...Object.entries(AREA_HINTS),
    ...HK_DISTRICTS.map((d) => [d.en, d.id] as [string, string]),
  ];

  // Slide a window over the text sized to each candidate, so a name embedded in
  // a longer string ("Fortress Mong Kong branch") can still match.
  const flat = squash(hay);
  let best = "";
  let bestScore = Infinity;

  for (const [label, id] of candidates) {
    const needle = squash(label);
    // Only fuzzy-match reasonably long names; short ones collide too easily.
    if (needle.length < 6) continue;
    const maxEdits = needle.length >= 10 ? 2 : 1;

    for (let i = 0; i + needle.length - maxEdits <= flat.length; i++) {
      for (const len of [needle.length - 1, needle.length, needle.length + 1]) {
        if (len <= 0 || i + len > flat.length) continue;
        const d = editDistance(needle, flat.slice(i, i + len));
        if (d <= maxEdits && d < bestScore) {
          bestScore = d;
          best = id;
        }
      }
    }
  }
  return best;
}
