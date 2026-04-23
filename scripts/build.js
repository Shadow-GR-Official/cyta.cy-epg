import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

// --------------------
// SAFE OUTPUT FOLDERS
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

const STREAM_BASE = "http://dummy.stream";

const limit = pLimit(5);

// --------------------
// FETCH CHANNELS (DYNAMIC)
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

    return (res.data.channels || []).map(c => c.id);
  } catch (err) {
    console.log("❌ fetchChannels failed");
    return [];
  }
}

// --------------------
// BUILD EPG URL (AUTO DATE + CHANNELS)
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
  const channelIds = await fetchChannels();

  if (!channelIds.length) {
    console.log("❌ no channels found");
    return [];
  }

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

    return res.data.channelEpgs || [];
  } catch (err) {
    console.log("❌ fetchEpg failed");
    return [];
  }
}

// --------------------
// EXTRACT ONLY EVENT IDs
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
// TIME FORMAT
// --------------------
function formatTime(epoch) {
  return DateTime
    .fromMillis(Number(epoch), { zone: "Europe/Nicosia" })
    .toFormat("yyyyMMddHHmmss ZZZZ");
}

// --------------------
// MAIN BUILD
// --------------------
async function build() {
  const raw = await fetchBaseEpg();

  if (!raw.length) {
    console.log("⚠️ no EPG data");
    return;
  }

  const eventsBase = extractEventIds(raw);

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
    console.log("⚠️ empty enriched data");
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
  // M3U
  // --------------------
  const channels = [...new Set(clean.map(e => e.channel))];

  const m3u = ["#EXTM3U"];

  for (const id of channels) {
    m3u.push(`#EXTINF:-1 tvg-id="${id}" tvg-name="${id}" tvg-logo="",${id}`);
    m3u.push(`${STREAM_BASE}/${id}`);
  }

  fs.writeFileSync(OUTPUT_M3U, m3u.join("\n"));

  console.log("✅ BUILD COMPLETE");
}

build();
