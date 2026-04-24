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
// SETUP
// --------------------
fs.mkdirSync("./data", { recursive: true });
fs.mkdirSync("./cache", { recursive: true });

const CHANNELS_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchChannels?language=1";

const FETCH_EPG_BASE =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpg";

const DETAILS_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpgDetails?language=1&id=";

const OUTPUT_XML = "./data/epg.xml";
const OUTPUT_M3U = "./data/channels.m3u";

const STREAM_BASE = "http://127.0.0.1";

const limit = pLimit(1);

// --------------------
// CHANNELS
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
  } catch (err) {
    log("ERROR", "fetchChannels failed");
    return new Map();
  }
}

// --------------------
// EPG URL
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
      log("WARN", `Day ${d} failed`);
    }

    await sleep(400);
  }

  log("EPG", `Total entries: ${all.length}`);
  return { data: all, channelMap };
}

// --------------------
// PARSER (FIXED + STRICT)
// --------------------
function extractEventIds(channelEpgs) {
  log("EVENTS", "Extracting event IDs...");

  const result = [];

  for (const ch of channelEpgs) {
    if (!Array.isArray(ch.epgPlayables)) continue;

    for (const ev of ch.epgPlayables) {
      if (!ev || typeof ev !== "object") continue;

      // 🔥 ONLY REAL EVENTS
      if (
        typeof ev.id !== "string" ||
        !/^\d+$/.test(ev.id) ||
        !ev.channelId ||
        typeof ev.startTime !== "number" ||
        typeof ev.endTime !== "number"
      ) {
        continue;
      }

      result.push({
        id: ev.id,
        channelId: ev.channelId,
        startTime: ev.startTime,
        endTime: ev.endTime
      });
    }
  }

  log("EVENTS", `Clean events: ${result.length}`);
  return result;
}

// --------------------
// DEDUPE
// --------------------
function dedupeEvents(events) {
  const seen = new Set();

  return events.filter(e => {
    const key = `${e.id}-${e.channelId}-${e.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// --------------------
// DETAILS
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
      if (i === retries) return null;
      await sleep(1000 * i);
    }
  }
}

// --------------------
// XML
// --------------------
function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildXML(channelMap, clean) {
  const lines = [];
  const seen = new Set();

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<tv>`);

  for (const e of clean) {
    if (seen.has(e.channel)) continue;

    const ch = channelMap.get(e.channel);
    if (!ch) continue;

    lines.push(`  <channel id="${e.channel}">`);
    lines.push(`    <display-name>${escapeXml(ch.name)}</display-name>`);
    lines.push(`  </channel>`);

    seen.add(e.channel);
  }

  for (const e of clean) {
    lines.push(`  <programme start="${e.start}" stop="${e.stop}" channel="${e.channel}">`);
    lines.push(`    <title lang="el">${escapeXml(e.title)}</title>`);

    if (e.desc) lines.push(`    <desc lang="el">${escapeXml(e.desc)}</desc>`);
    if (e.category) lines.push(`    <category lang="el">${escapeXml(e.category)}</category>`);
    if (e.rating) lines.push(`    <rating>${escapeXml(e.rating)}</rating>`);

    lines.push(`  </programme>`);
  }

  lines.push(`</tv>`);
  return lines.join("\n");
}

// --------------------
// M3U
// --------------------
function buildM3U(channelMap, channels) {
  const out = ["#EXTM3U"];

  for (const id of channels) {
    const ch = channelMap.get(id);
    const name = (ch?.name || id).trim();
    const logo = ch?.logo || "";

    out.push(`#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}",${name}`);
    out.push(`${STREAM_BASE}/${id}`);
  }

  return out.join("\n");
}

// --------------------
// MAIN
// --------------------
async function build() {
  log("MAIN", "START");

  const { data, channelMap } = await fetchBaseEpg(7);
  if (!data.length) return;

  const events = dedupeEvents(extractEventIds(data));

  let counter = 0;
  let fails = 0;

  const enriched = await Promise.all(
    events.map(ev =>
      limit(async () => {
        counter++;

        const d = await fetchDetails(ev.id);

        if (!d) {
          if (++fails > 10) {
            await sleep(5000);
            fails = 0;
          }
          return null;
        }

        fails = 0;

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

  fs.writeFileSync(OUTPUT_XML, buildXML(channelMap, clean));
  fs.writeFileSync(OUTPUT_M3U, buildM3U(channelMap, [...new Set(clean.map(e => e.channel))]));

  log("DONE", "BUILD COMPLETE");
}

build();
