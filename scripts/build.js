import axios from "axios";
import fs from "fs";
import { XMLBuilder } from "fast-xml-parser";
import { DateTime } from "luxon";
import pLimit from "p-limit";

const BASE_EPG_URL = "https://epg.cyta.com.cy/api/mediacatalog/fetchEpg";
const DETAILS_URL = "https://epg.cyta.com.cy/api/mediacatalog/fetchEpgDetails?language=1&id=";

const OUTPUT_XML = "./data/epg.xml";
const OUTPUT_M3U = "./data/channels.m3u";

const STREAM_BASE = "http://dummy.stream";

const limit = pLimit(10);

// -------------------------
// FETCH BASE (ONLY IDs)
// -------------------------
async function fetchBaseEpg() {
  const res = await axios.get(BASE_EPG_URL);
  return res.data;
}

// -------------------------
// FETCH DETAILS
// -------------------------
async function fetchDetails(id) {
  const res = await axios.get(DETAILS_URL + id);
  return res.data.playbillDetail;
}

// -------------------------
// TIME CONVERT (IMPORTANT)
// -------------------------
function formatTime(epoch) {
  return DateTime
    .fromMillis(Number(epoch), { zone: "Europe/Nicosia" })
    .toFormat("yyyyMMddHHmmss ZZZZ");
}

// -------------------------
// MAIN
// -------------------------
async function build() {
  const base = await fetchBaseEpg();

  const events = base.events.map(ev =>
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
  );

  const enriched = await Promise.all(events);

  // -------------------------
  // XMLTV
  // -------------------------
  const xml = new XMLBuilder({ ignoreAttributes: false, format: false });

  const epg = {
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
  };

  fs.writeFileSync(OUTPUT_XML, xml.build(epg).trim());

  // -------------------------
  // M3U (logos[0] + id stream)
  // -------------------------
  const channelsMap = {};

  enriched.forEach(e => {
    channelsMap[e.channel] = true;
  });

  const m3uLines = ["#EXTM3U"];

  Object.keys(channelsMap).forEach(id => {
    m3uLines.push(
      `#EXTINF:-1 tvg-id="${id}" tvg-name="${id}" tvg-logo="${id}",${id}`
    );
    m3uLines.push(`${STREAM_BASE}/${id}`);
  });

  fs.writeFileSync(OUTPUT_M3U, m3uLines.join("\n"));

  console.log("DONE");
}

build();
