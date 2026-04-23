import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

// --------------------
// FOLDERS
// --------------------
fs.mkdirSync("./data", { recursive: true });
fs.mkdirSync("./cache", { recursive: true });

// --------------------
// ENDPOINTS
// --------------------
const CHANNELS_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchChannels?language=1";

const FETCH_EPG_BASE =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpg";

const DETAILS_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpgDetails?language=1&id=";

const OUTPUT_XML = "./data/epg.xml";
const OUTPUT_M3U = "./data/channels.m3u";

const STREAM_BASE = "http://127.0.0.1";

const limit = pLimit(5);

// --------------------
// FETCH CHANNELS (ID → NAME → LOGO)
// --------------------
async function fetchChannels() {
  try {
    const res = await axios.get(CHANNELS_URL, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://epg.cyta.com.cy/"
      }
    });

    const map = new Map();

    for (const c of res.data.channels || []) {
      map.set(c.id, {
        id: c.id,
        name: c.name,
        logo: c.picture?.icons?.[0] || ""
      });
    }

    return map;
  } catch (err) {
    console.log("❌ fetchChannels failed");
    return new Map();
  }
}

// --------------------
// BUILD EPG URL (TODAY AUTO)
// --------------------
function buildEpgUrl(channelIds) {
  const start = DateTime.now()
    .setZone("Europe/Nicosia")
    .startOf("day")
    .toMillis();

  const end = DateTime.now()
    .setZone("Europe/Nicosia")
    .endOf("day")
    .toMillis();

  return `${FETCH_EPG_BASE}?startTimeEpoch=${start}&endTimeEpoch=${end}&language=1&channelIds=${channelIds.join(",")}`;
}

// --------------------
// FETCH BASE EPG
// --------------------
async function fetchBaseEpg() {
  const channelMap = await fetchChannels();

  const channelIds = [...channelMap.keys()];

  const url = buildEpgUrl(channelIds);

  try {
    const res = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json",
        "Referer": "https://epg.cyta.com.cy/"
      }
    });

    return {
      data: res.data.channelEpgs || [],
      channelMap
    };
  } catch (err) {
    console.log("❌ fetchEpg failed");
    return { data: [], channelMap };
  }
}

// --------------------
// EXTRACT EVENT IDS ONLY
// --------------------
function extractEventIds(channelEpgs) {
  return channelEpgs.flatMap(ch =>
    (ch.epgPlayables || []).map(ev => ({
      id: ev.id,
      channelId: ev.channelId
    }))
  );
}

// --------------------
// FETCH DETAILS
// --------------------
async function fetchDetails(id) {
  try {
    const res = await axios.get(DETAILS_URL + id, {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });

    return res.data.playbillDetail;
  } catch {
    return null;
  }
}

// --------------------
// TIME FORMAT (CYTA SAFE)
// --------------------
function formatTime(epoch) {
  return DateTime
    .fromMillis(Number(epoch), { zone: "Europe/Nicosia" })
    .toFormat("yyyyMMddHHmmss ZZZZ");
}

// --------------------
// M3U BUILDER (EXACT FORMAT YOU WANTED)
// --------------------
function buildM3U(channelMap, eventChannels) {
  const m3u = ["#EXTM3U"];

  for (const id of eventChannels) {
    const ch = channelMap.get(id);

    const tvgId = ch?.id || id;
    const tvgName = ch?.name || id;
    const logo = ch?.logo || "";

    m3u.push(
      `#EXTINF:-1 tvg-id="${tvgId}" tvg-name="${tvgName}" tvg-logo="${logo}",${tvgName}`
    );

    m3u.push(`${STREAM_BASE}/${tvgId}`);
  }

  return m3u.join("\n");
}

// --------------------
// MAIN BUILD
// --------------------
async function build() {
  const { data, channelMap } = await fetchBaseEpg();

  if (!data.length) {
    console.log("⚠️ No EPG data");
    return;
  }

  const eventsBase = extractEventIds(data);

  const enriched = await Promise.all(
    eventsBase.map(ev =>
      limit(async () => {
        const d = await fetchDetails(ev.id);
        if (!d) return null;

        return {
          id: ev.id,
          channel: ev.channelId,
          start: formatTime(d.startTime),
          stop: formatTime(d.endTime),
          title: d.name,
          desc: d.introduce,
          category: d.genres?.[0]?.genreName || "",
          rating: d.rating?.name || ""
        };
      })
    )
  );

  const clean = enriched.filter(Boolean);

  if (!clean.length) {
    console.log("⚠️ No enriched data");
    return;
  }

  // --------------------
  // XMLTV
  // --------------------
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: false
  });

  const xml = builder.build({
    tv: {
      programme: clean.map(e => ({
        "@_start": e.start,
        "@_stop": e.stop,
        "@_channel": e.channel,
        title: e.title,
        desc: e.desc,
        category: e.category,
        rating: e.rating
      }))
    }
  });

  fs.writeFileSync(OUTPUT_XML, xml.trim());

  // --------------------
  // M3U (EXACT FORMAT)
  // --------------------
  const eventChannels = [...new Set(clean.map(e => e.channel))];

  const m3u = buildM3U(channelMap, eventChannels);

  fs.writeFileSync(OUTPUT_M3U, m3u);

  console.log("✅ BUILD COMPLETE");
}

build();
