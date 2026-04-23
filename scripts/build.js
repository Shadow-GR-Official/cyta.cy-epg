import axios from "axios";
import fs from "fs";
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

// πιο safe για weekly
const limit = pLimit(3);

// --------------------
// INDENT HELPER
// --------------------
const indent = (spaces, str) => " ".repeat(spaces) + str;

// --------------------
// FETCH CHANNELS
// --------------------
async function fetchChannels() {
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

    return map;
  } catch {
    console.log("❌ fetchChannels failed");
    return new Map();
  }
}

// --------------------
// BUILD URL (WITH DAY OFFSET)
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
// FETCH WEEK (7 DAYS)
// --------------------
async function fetchBaseEpg(days = 7) {
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

      console.log(`✔ Day ${d} OK`);
    } catch {
      console.log(`⚠️ Day ${d} failed`);
    }
  }

  return { data: all, channelMap };
}

// --------------------
// EVENTS
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
// DEDUPE EVENTS
// --------------------
function dedupeEvents(events) {
  const seen = new Set();
  return events.filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
}

// --------------------
// DETAILS
// --------------------
async function fetchDetails(id) {
  try {
    const res = await axios.get(DETAILS_URL + id, {
      timeout: 20000,
      headers: { Accept: "application/json" }
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
  return DateTime.fromMillis(Number(epoch), {
    zone: "Europe/Nicosia"
  }).toFormat("yyyyMMddHHmmss ZZZZ");
}

// --------------------
// XML ESCAPE
// --------------------
function escapeXml(str) {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// --------------------
// XML BUILDER (FINAL FORMAT - PERFECT)
// --------------------
function buildXML(channelMap, clean) {
  const lines = [];
  const seenChannels = new Set();

  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<tv>`);

  // CHANNELS
  for (const e of clean) {
    const chId = e.channel;
    if (seenChannels.has(chId)) continue;

    const ch = channelMap.get(chId);
    if (!ch) continue;

    lines.push(indent(2, `<channel id="${chId}">`));
    lines.push(indent(4, `<display-name>${escapeXml(ch.name)}</display-name>`));
    lines.push(indent(2, `</channel>`));

    seenChannels.add(chId);
  }

  // PROGRAMMES
  for (const e of clean) {
    lines.push(
      indent(
        2,
        `<programme start="${e.start}" stop="${e.stop}" channel="${e.channel}">`
      )
    );

    lines.push(indent(4, `<title lang="el">${escapeXml(e.title)}</title>`));

    if (e.desc && e.desc !== e.title) {
      lines.push(indent(4, `<desc lang="el">${escapeXml(e.desc)}</desc>`));
    }

    if (e.category) {
      lines.push(
        indent(4, `<category lang="el">${escapeXml(e.category)}</category>`)
      );
    }

    if (e.rating) {
      lines.push(indent(4, `<rating>${escapeXml(e.rating)}</rating>`));
    }

    lines.push(indent(2, `</programme>`));
  }

  lines.push(`</tv>`);

  return lines.join("\n");
}

// --------------------
// M3U (UNCHANGED)
// --------------------
function buildM3U(channelMap, eventChannels) {
  const m3u = ["#EXTM3U"];

  for (const id of eventChannels) {
    const ch = channelMap.get(id);

    const name = (ch?.name || id).trim();
    const logo = ch?.logo || "";

    m3u.push(
      `#EXTINF:-1 tvg-id="${id}" tvg-name="${name}" tvg-logo="${logo}",${name}`
    );

    m3u.push(`${STREAM_BASE}/${id}`);
  }

  return m3u.join("\n");
}

// --------------------
// MAIN
// --------------------
async function build() {
  const { data, channelMap } = await fetchBaseEpg(7);

  if (!data.length) {
    console.log("⚠️ No EPG data");
    return;
  }

  const eventsBase = dedupeEvents(extractEventIds(data));

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

  fs.writeFileSync(OUTPUT_XML, buildXML(channelMap, clean));

  const eventChannels = [...new Set(clean.map(e => e.channel))];
  fs.writeFileSync(OUTPUT_M3U, buildM3U(channelMap, eventChannels));

  console.log("✅ BUILD COMPLETE (WEEKLY)");
}

build();
