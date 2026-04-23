import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

const FETCH_EPG_URL = "https://epg.cyta.com.cy/api/mediacatalog/fetchEpg";
const DETAILS_URL = "https://epg.cyta.com.cy/api/mediacatalog/fetchEpgDetails?language=1&id=";

const OUTPUT_XML = "./data/epg.xml";
const OUTPUT_M3U = "./data/channels.m3u";

const STREAM_BASE = "http://dummy.stream";
const limit = pLimit(10);

// --------------------
// FETCH BASE (FIXED STRUCTURE)
// --------------------
async function fetchBaseEpg() {
  const res = await axios.get(FETCH_EPG_URL);
  return res.data.channelEpgs;
}

// --------------------
// EXTRACT ONLY EVENT IDS (IMPORTANT FIX)
// --------------------
function extractEventIds(channelEpgs) {
  return channelEpgs.flatMap(ch =>
    ch.epgPlayables.map(ev => ({
      id: ev.id,
      channelId: ev.channelId,
      startTime: ev.startTime,
      endTime: ev.endTime
    }))
  );
}

// --------------------
// FETCH DETAILS
// --------------------
async function fetchDetails(id) {
  const res = await axios.get(DETAILS_URL + id);
  return res.data.playbillDetail;
}

// --------------------
// TIME FIX (EPG SAFE)
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

  const eventsBase = extractEventIds(raw);

  const enriched = await Promise.all(
    eventsBase.map(ev =>
      limit(async () => {
        const d = await fetchDetails(ev.id);

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

  // --------------------
  // XMLTV (NO FORMATTING SPACING)
  // --------------------
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: false
  });

  const xml = builder.build({
    tv: {
      programme: enriched.map(e => ({
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
  // M3U (logos[0] rule + dummy stream)
  // --------------------
  const channels = [...new Set(enriched.map(e => e.channel))];

  const m3u = ["#EXTM3U"];

  for (const id of channels) {
    m3u.push(
      `#EXTINF:-1 tvg-id="${id}" tvg-name="${id}" tvg-logo="",${id}`
    );
    m3u.push(`${STREAM_BASE}/${id}`);
  }

  fs.writeFileSync(OUTPUT_M3U, m3u.join("\n"));

  console.log("BUILD COMPLETE ✔");
}

build();
