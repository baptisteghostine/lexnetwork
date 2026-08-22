// Freeform location → ISO numeric country id (SPEC §7a). Contacts carry
// location as entered ("Greater London, England, United Kingdom",
// "Zurich Metropolitan Area", "SF Bay Area") — the map needs a country,
// offline, with no geocoder call. Pure and unit-tested; anything this
// can't place lands in the map's "unrecognized" bucket rather than being
// guessed at.

import { countryNames, EXTRA_PLACES } from "./countries";

/** Lowercase, fold diacritics, collapse punctuation to spaces. Arabic is
 * normalized too (harakat stripped, alef variants and ta marbuta folded)
 * so "\u0627\u0644\u0625\u0645\u0627\u0631\u0627\u062a" and "\u0627\u0644\u0627\u0645\u0627\u0631\u0627\u062a" are the same key. */
export function normalizePlace(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u064b-\u0655\u0670]/g, "")
    .replace(/[\u0623\u0625\u0622\u0671]/g, "\u0627")
    .replace(/\u0629/g, "\u0647")
    .replace(/\u0649/g, "\u064a")
    .toLowerCase()
    .replace(/[().]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Names that differ from (or add to) the world-atlas display names.
const COUNTRY_ALIASES: Record<string, string> = {
  "united states": "840",
  usa: "840",
  us: "840",
  "u s a": "840",
  america: "840",
  "united states of america": "840",
  uk: "826",
  "united kingdom": "826",
  "great britain": "826",
  britain: "826",
  england: "826",
  scotland: "826",
  wales: "826",
  "northern ireland": "826",
  uae: "784",
  "united arab emirates": "784",
  "south korea": "410",
  korea: "410",
  "republic of korea": "410",
  "north korea": "408",
  "czech republic": "203",
  czechia: "203",
  "ivory coast": "384",
  "cote d'ivoire": "384",
  "cote divoire": "384",
  burma: "104",
  myanmar: "104",
  "democratic republic of the congo": "180",
  "dr congo": "180",
  drc: "180",
  "republic of the congo": "178",
  macedonia: "807",
  "north macedonia": "807",
  "bosnia and herzegovina": "070",
  bosnia: "070",
  "the netherlands": "528",
  holland: "528",
  "hong kong sar": "344",
  "hong kong": "344",
  macau: "446",
  "viet nam": "704",
  "east timor": "626",
  "timor leste": "626",
  eswatini: "748",
  swaziland: "748",
  "cape verde": "132",
  palestine: "275",
  "palestinian territories": "275",
  "russian federation": "643",
  turkiye: "792",
  "the gambia": "270",
  "sri lanka": "144",
  "new zealand": "554",
  "saudi arabia": "682",
  "south africa": "710",
  "dominican republic": "214",
  "puerto rico": "630",
  "trinidad and tobago": "780",
  "papua new guinea": "598",
  luxemburg: "442",
  // Native / localized country names — LinkedIn stores locations in the
  // profile's locale, so an exported network is multilingual (the owner's
  // real data has Schweiz, España, and Arabic strings side by side).
  schweiz: "756",
  suisse: "756",
  svizzera: "756",
  deutschland: "276",
  allemagne: "276",
  frankreich: "250",
  espana: "724",
  espagne: "724",
  spanien: "724",
  italia: "380",
  italie: "380",
  italien: "380",
  nederland: "528",
  "pays-bas": "528",
  "pays bas": "528",
  niederlande: "528",
  belgique: "056",
  belgie: "056",
  belgien: "056",
  osterreich: "040",
  autriche: "040",
  sverige: "752",
  norge: "578",
  danmark: "208",
  suomi: "246",
  polska: "616",
  portugal: "620",
  brasil: "076",
  mexico: "484",
  maroc: "504",
  tunisie: "788",
  algerie: "012",
  "royaume-uni": "826",
  "royaume uni": "826",
  "etats-unis": "840",
  "etats unis": "840",
  "vereinigtes konigreich": "826",
  grossbritannien: "826",
  "vereinigte staaten": "840",
  liban: "422",
  "emirats arabes unis": "784",
  "arabie saoudite": "682",
  // Arabic country names (keys are written post-normalization: alef
  // unified, ta marbuta → ه).
  "لبنان": "422",
  "الامارات": "784",
  "الامارات العربيه المتحده": "784",
  "السعوديه": "682",
  "المملكه العربيه السعوديه": "682",
  "مصر": "818",
  "الاردن": "400",
  "قطر": "634",
  "الكويت": "414",
  "البحرين": "048",
  "العراق": "368",
  "سوريا": "760",
  "فلسطين": "275",
  "المغرب": "504",
  "تونس": "788",
  "الجزائر": "012",
  "سلطنه عمان": "512",
};

const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado",
  "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho",
  "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine",
  "maryland", "massachusetts", "michigan", "minnesota", "mississippi",
  "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina",
  "south dakota", "tennessee", "texas", "utah", "vermont", "virginia",
  "washington", "west virginia", "wisconsin", "wyoming",
  "district of columbia", "washington dc", "washington d c",
] as const;

const CA_PROVINCES = [
  "ontario", "quebec", "british columbia", "alberta", "manitoba",
  "saskatchewan", "nova scotia", "new brunswick",
  "newfoundland and labrador", "prince edward island",
] as const;

// Major cities/metros that show up in LinkedIn-style locations without a
// country. Curated, not exhaustive — an unknown city is reported, not
// guessed. All values are ISO numeric ids.
const CITIES: Record<string, string> = {
  // US
  "new york city": "840", nyc: "840", "san francisco": "840",
  "sf bay area": "840", "san francisco bay area": "840", "bay area": "840",
  "los angeles": "840", chicago: "840", boston: "840", seattle: "840",
  austin: "840", miami: "840", denver: "840", atlanta: "840",
  houston: "840", dallas: "840", "san diego": "840", "san jose": "840",
  philadelphia: "840", phoenix: "840", portland: "840", detroit: "840",
  "salt lake city": "840", minneapolis: "840", pittsburgh: "840",
  // UK
  london: "826", "greater london": "826", manchester: "826",
  edinburgh: "826", glasgow: "826", birmingham: "826", cambridge: "826",
  oxford: "826", bristol: "826", leeds: "826",
  // Europe
  paris: "250", lyon: "250", marseille: "250", toulouse: "250",
  berlin: "276", munich: "276", frankfurt: "276", hamburg: "276",
  cologne: "276", stuttgart: "276", dusseldorf: "276",
  zurich: "756", geneva: "756", basel: "756", lausanne: "756", zug: "756",
  vienna: "040", amsterdam: "528", rotterdam: "528", "the hague": "528",
  brussels: "056", antwerp: "056", madrid: "724", barcelona: "724",
  valencia: "724", lisbon: "620", porto: "620", milan: "380", rome: "380",
  turin: "380", florence: "380", dublin: "372", stockholm: "752",
  gothenburg: "752", copenhagen: "208", oslo: "578", helsinki: "246",
  warsaw: "616", krakow: "616", prague: "203", budapest: "348",
  bucharest: "642", athens: "300", istanbul: "792", ankara: "792",
  moscow: "643", "saint petersburg": "643", kyiv: "804", kiev: "804",
  luxembourg: "442",
  // Middle East & Africa
  dubai: "784", "abu dhabi": "784", riyadh: "682", jeddah: "682",
  doha: "634", "kuwait city": "414", manama: "048", muscat: "512",
  "tel aviv": "376", jerusalem: "376", beirut: "422", amman: "400",
  cairo: "818", casablanca: "504", tunis: "788", lagos: "566",
  abuja: "566", nairobi: "404", "cape town": "710", johannesburg: "710",
  accra: "288", "addis ababa": "231",
  // Asia & Oceania
  tokyo: "392", osaka: "392", kyoto: "392", seoul: "410", busan: "410",
  beijing: "156", shanghai: "156", shenzhen: "156", guangzhou: "156",
  taipei: "158", bangkok: "764", "ho chi minh city": "704", hanoi: "704",
  jakarta: "360", "kuala lumpur": "458", manila: "608", mumbai: "356",
  delhi: "356", "new delhi": "356", bangalore: "356", bengaluru: "356",
  hyderabad: "356", chennai: "356", pune: "356", karachi: "586",
  lahore: "586", islamabad: "586", dhaka: "050", colombo: "144",
  sydney: "036", melbourne: "036", brisbane: "036", perth: "036",
  auckland: "554", wellington: "554", tbilisi: "268", batumi: "268",
  yerevan: "051", baku: "031", almaty: "398", tashkent: "860",
  // Americas
  toronto: "124", vancouver: "124", montreal: "124", ottawa: "124",
  calgary: "124", "mexico city": "484", guadalajara: "484",
  "sao paulo": "076", "rio de janeiro": "076", "buenos aires": "032",
  santiago: "152", bogota: "170", medellin: "170", lima: "604",
  quito: "218", montevideo: "858", "san juan": "630", havana: "192",
  // Localized city spellings (keys post-normalization)
  genf: "756", geneve: "756", zuerich: "756", wien: "040",
  munchen: "276", muenchen: "276", koln: "276", praha: "203",
  warszawa: "616", lisboa: "620", sevilla: "724", roma: "380",
  milano: "380", torino: "380", firenze: "380", napoli: "380",
  "den haag": "528", kobenhavn: "208", moskva: "643",
  "بيروت": "422", "دبي": "784", "ابوظبي": "784", "الرياض": "682",
  "القاهره": "818", "الدوحه": "634", "جده": "682",
};

// "Georgia" is both a US state and a country; decide from the rest of
// the string, defaulting to the country when nothing disambiguates.
const AMBIGUOUS_STATE_COUNTRY: Record<string, { state: string; country: string }> = {
  georgia: { state: "840", country: "268" },
};

let nameTable: Map<string, string> | null = null;
function countryNameTable(): Map<string, string> {
  if (!nameTable) {
    nameTable = new Map();
    for (const [id, name] of countryNames()) {
      nameTable.set(normalizePlace(name), id);
    }
    for (const p of EXTRA_PLACES) nameTable.set(normalizePlace(p.name), p.id);
    // Aliases and cities run through the same normalizer as queries, so
    // the tables can be written naturally and never drift from it.
    for (const [alias, id] of Object.entries(COUNTRY_ALIASES)) {
      nameTable.set(normalizePlace(alias), id);
    }
  }
  return nameTable;
}

let cityTable: Map<string, string> | null = null;
function normalizedCityTable(): Map<string, string> {
  if (!cityTable) {
    cityTable = new Map();
    for (const [city, id] of Object.entries(CITIES)) {
      cityTable.set(normalizePlace(city), id);
    }
  }
  return cityTable;
}

const WRAPPERS =
  /^(greater\s+)|(\s+(metropolitan\s+area|metro\s+area|area|region|county))$/g;

function stripWrappers(part: string): string {
  let out = part;
  for (let i = 0; i < 3; i++) out = out.replace(WRAPPERS, "").trim();
  return out;
}

function lookupPart(part: string): string | null {
  const direct = countryNameTable().get(part);
  if (direct) return direct;
  if ((US_STATES as readonly string[]).includes(part)) return "840";
  if ((CA_PROVINCES as readonly string[]).includes(part)) return "124";
  const city = normalizedCityTable().get(part);
  if (city) return city;
  // Comma-less strings ("محافظة بيروت لبنان", "Lausanne Waadt Schweiz")
  // arrive as one part — try word suffixes, where the country ends up.
  const words = part.split(" ");
  for (let i = 1; i < words.length && words.length > 1; i++) {
    const suffix = words.slice(i).join(" ");
    const hit =
      countryNameTable().get(suffix) ?? normalizedCityTable().get(suffix);
    if (hit) return hit;
  }
  return null;
}

/**
 * Resolve a freeform location to an ISO numeric country id, or null when
 * nothing in the string is recognized. Parts are tried right-to-left —
 * the country/region end of "City, Region, Country" — with city names as
 * the fallback for bare "London" / "Zurich Metropolitan Area" entries.
 */
export function resolveCountry(location: string | null): string | null {
  if (!location) return null;
  // Each part is tried as written first ("san francisco bay area" is a
  // table key), then with metro wrappers stripped ("greater zurich area"
  // → "zurich").
  const parts = normalizePlace(location)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const stripped = stripWrappers(p);
      return stripped && stripped !== p ? [p, stripped] : [p];
    });
  if (parts.length === 0) return null;

  const lookupVariants = (variants: string[]): string | null => {
    for (const v of variants) {
      const hit = lookupPart(v);
      if (hit) return hit;
    }
    return null;
  };

  for (let i = parts.length - 1; i >= 0; i--) {
    const ambiguous = parts[i]
      .map((v) => AMBIGUOUS_STATE_COUNTRY[v])
      .find((a) => a !== undefined);
    if (ambiguous) {
      // Let any other recognizable part cast the deciding vote.
      for (let j = 0; j < parts.length; j++) {
        if (j === i) continue;
        const other = lookupVariants(parts[j]);
        if (other === "840") return ambiguous.state;
        if (other !== null) return other;
      }
      return parts.length === 1 ? ambiguous.country : ambiguous.state;
    }
    const hit = lookupVariants(parts[i]);
    if (hit) return hit;
  }
  return null;
}
