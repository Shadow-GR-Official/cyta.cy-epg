import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

// --------------------
// FOLDERS SAFE INIT
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

// 🔥 LOWER LOAD (important for stability)
const limit = pLimit(5);

// --------------------
// SAFE FETCH EPG (WITH HEADERS + RETRY)
// --------------------
async function fetchBaseEpg() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.get(FETCH_EPG_URL, {
        timeout: 30000,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
          "Accept": "application/json",
          "Referer": "https://epg.cyta.com.cy/"
        }
      });

      return res.data.channelEpgs || [];
    } catch (err) {
      console.log(`⚠️ fetchEpg attempt ${attempt} failed`);

      if (err.response) {
        console.log("STATUS:", err.response.status);
      }

      await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.log("❌ fetchEpg completely failed");
  return [];
}

// --------------------
// EXTRACT ONLY EVENT IDS (STRICT RULE)
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
    console.log("⚠️ No EPG data received - exit safe");
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
  // XMLTV BUILD
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
  // M3U BUILD
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
