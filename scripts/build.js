import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

// --------------------
// FOLDERS (IMPORTANT FIX)
// --------------------
fs.mkdirSync("./data", { recursive: true });
fs.mkdirSync("./cache", { recursive: true });

// --------------------
// ENDPOINTS
// --------------------
const FETCH_EPG_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpg";

const DETAILS_URL =
  "https://epg.cyta.com.cy/api/mediacatalog/fetchEpgDetails?language=1&id=";

const OUTPUT_XML = "./data/epg.xml";
const OUTPUT_M3U = "./data/channels.m3u";

const STREAM_BASE = "http://dummy.stream";

// 🔥 LOW LOAD (prevents API blocking)
const limit = pLimit(5);

// --------------------
// SAFE BASE FETCH (NO CRASH)
// --------------------
async function fetchBaseEpg() {
  try {
    const res = await axios.get(FETCH_EPG_URL, { timeout: 30000 });
    return res.data.channelEpgs || [];
  } catch (err) {
    console.error("⚠️ fetchEpg failed, retrying...");

    try {
      const retry = await axios.get(FETCH_EPG_URL, {
        timeout: 30000
      });
      return retry.data.channelEpgs || [];
    } catch (err2) {
      console.error("❌ fetchEpg failed completely");
      return [];
    }
  }
}

// --------------------
// EXTRACT ONLY EVENT IDs (CRITICAL RULE)
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
// SAFE DETAILS FETCH
// --------------------
async function fetchDetails(id) {
  try {
    const res = await axios.get(DETAILS_URL + id, {
      timeout: 20000
    });

    return res.data.playbillDetail;
  } catch (err) {
    return null; // skip broken event instead of crashing
  }
}

// --------------------
// TIME CONVERSION (DST SAFE)
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
    console.log("⚠️ No EPG data - exiting safely");
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
    console.log("⚠️ No valid events after enrichment");
    return;
  }

  // --------------------
  // XMLTV BUILD (NO FORMATTING SPACES)
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
  // M3U BUILD (minimal + stable)
  // --------------------
  const channels = [...new Set(clean.map(e => e.channel))];

  const m3u = ["#EXTM3U"];

  for (const id of channels) {
    m3u.push(
      `#EXTINF:-1 tvg-id="${id}" tvg-name="${id}" tvg-logo="",${id}`
    );
    m3u.push(`${STREAM_BASE}/${id}`);
  }

  fs.writeFileSync(OUTPUT_M3U, m3u.join("\n"));

  console.log("✅ BUILD COMPLETE");
}

build();
