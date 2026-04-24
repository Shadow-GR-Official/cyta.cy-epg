import axios from "axios";
import fs from "fs";
import { DateTime } from "luxon";
import pLimit from "p-limit";

// --------------------
// HELPERS
// --------------------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatTime(epoch) {
  return DateTime.fromMillis(Number(epoch), {
    zone: "Europe/Nicosia"
  }).toFormat("yyyyMMddHHmmss ZZZZ");
}

// --------------------
// LOGGER
// --------------------
function log(step, msg) {
  const time = DateTime.now().toFormat("HH:mm:ss");
  console.log(`[${time}] [${step}] ${msg}`);
}

// --------------------
// FOLDERS
// --------------------
log("INIT", "Creating folders...");
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

// 🔥 πιο safe
const limit = pLimit(1);

// --------------------
// HELPERS
// --------------------
const indent = (spaces, str) => " ".repeat(spaces) + str;

// --------------------
// FETCH CHANNELS
// --------------------
async function fetchChannels() {
  log("CHANNELS", "Fetching channel list...");

  try {
    const res = await axios.get(CHANNELS_URL, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        Referer: "https://epg.cyta.com.cy/"
      }
    });

    const map = new Map();

    for (const c of res.data.channels || []) {
      map.set(c.id, {
        id: c.id,
        name: (c.name || "").trim(),
        logo: c.picture?.icons?.[0] || ""
      });
    }

    log("CHANNELS", `Loaded ${map.size} channels`);
    return map;
  } catch {
    log("ERROR", "fetchChannels failed");
    return new Map();
  }
}

// --------------------
// BUILD URL
// --------------------
function buildEpgUrl(channelIds, dayOffset = 0) {
  const base = DateTime.now()
    .setZone("Europe/Nicosia")
    .plus({ days: dayOffset });

  const start = base.startOf("day").toMillis();
  const end = base.endOf("day").toMillis();

  return `${FETCH_EPG_BASE}?startTimeEpoch=${start}&endTimeEpoch=${end}&language=1&channelIds=${channelIds.join(",")}`;
}

// --------------------
// FETCH WEEK
// --------------------
async function fetchBaseEpg(days = 7) {
  log("EPG", `Fetching EPG for ${days} days...`);

  const channelMap = await fetchChannels();
  const channelIds = [...channelMap.keys()];

  let all = [];

  for (let d = 0; d < days; d++) {
    log("EPG", `Fetching day ${d}...`);

    try {
      const res = await axios.get(buildEpgUrl(channelIds, d), {
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0",
          Accept: "application/json",
          Referer: "https://epg.cyta.com.cy/"
        }
      });

      const dayData = res.data.channelEpgs || [];
      all = all.concat(dayData);

      log("EPG", `✔ Day ${d} OK (${dayData.length} channels)`);
    } catch {
      log("WARN", `⚠️ Day ${d} failed`);
    }

    // μικρό throttle
    await sleep(500);
  }

  log("EPG", `Total EPG entries: ${all.length}`);
  return { data: all, channelMap };
}

// --------------------
// EVENTS
// --------------------
function extractEventIds(channelEpgs) {
  log("EVENTS", "Extracting event IDs...");
  const result = channelEpgs.flatMap(ch =>
    (ch.epgPlayables || []).map(ev => ({
      id: ev.id,
      channelId: ev.channelId
    }))
  );

  log("EVENTS", `Extracted ${result.length} raw events`);
  return result;
}

// --------------------
// DEDUPE
// --------------------
function dedupeEvents(events) {
  log("EVENTS", "Deduplicating events...");
  const seen = new Set();

  const clean = events.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  log("EVENTS", `After dedupe: ${clean.length}`);
  return clean;
}

// --------------------
// DETAILS (FIXED)
// --------------------
async function fetchDetails(id, retries = 3) {
  for (let i = 1; i <= retries; i++) {
    try {
      const res = await axios.get(DETAILS_URL + id, {
        timeout: 20000,
        headers: { Accept: "application/json" }
      });

      return res.data.playbillDetail;
    } catch (err) {
      const status = err?.response?.status;

      log(
        "WARN",
        `Details ${id} failed (try ${i}) status=${status || "NO_RESPONSE"}`
      );

      if (i === retries) {
        log("ERROR", `Details ${id} FAILED`);
        return null;
      }

      const delay = 1000 * i;
      log("WAIT", `Retrying ${id} in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// --------------------
// MAIN
// --------------------
async function build() {
  log("MAIN", "Starting build process...");

  const { data, channelMap } = await fetchBaseEpg(7);

  if (!data.length) {
    log("ERROR", "No EPG data");
    return;
  }

  const eventsBase = dedupeEvents(extractEventIds(data));

  log("DETAILS", `Fetching details for ${eventsBase.length} events...`);

  let counter = 0;
  let consecutiveFails = 0;

  const enriched = await Promise.all(
    eventsBase.map(ev =>
      limit(async () => {
        counter++;

        log("DETAILS", `(${counter}/${eventsBase.length}) Fetching ${ev.id}`);

        // throttle
        await sleep(80);

        const d = await fetchDetails(ev.id);

        if (!d) {
          consecutiveFails++;

          if (consecutiveFails >= 10) {
            log("BLOCK", "Too many fails → cooling down 5s...");
            await sleep(5000);
            consecutiveFails = 0;
          }

          return null;
        }

        consecutiveFails = 0;

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

  log("BUILD", `Final events: ${clean.length}`);

  log("FILE", "Writing XML...");
  fs.writeFileSync(OUTPUT_XML, buildXML(channelMap, clean));

  const eventChannels = [...new Set(clean.map(e => e.channel))];

  log("FILE", "Writing M3U...");
  fs.writeFileSync(OUTPUT_M3U, buildM3U(channelMap, eventChannels));

  log("DONE", "✅ BUILD COMPLETE (WEEKLY)");
}

build();
