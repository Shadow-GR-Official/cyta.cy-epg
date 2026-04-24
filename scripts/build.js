function extractEventIds(channelEpgs) {
  log("EVENTS", "Extracting event IDs...");

  const result = [];

  for (const ch of channelEpgs) {
    if (!Array.isArray(ch.epgPlayables)) continue;

    for (const ev of ch.epgPlayables) {

      // 🔒 must be object
      if (!ev || typeof ev !== "object") continue;

      // 🔒 must have valid numeric id
      if (typeof ev.id !== "string") continue;
      if (!/^\d+$/.test(ev.id)) continue;

      // 🔒 must have required fields
      if (!ev.channelId) continue;
      if (typeof ev.startTime !== "number") continue;
      if (typeof ev.endTime !== "number") continue;

      result.push({
        id: ev.id,
        channelId: ev.channelId,
        startTime: ev.startTime,
        endTime: ev.endTime
      });
    }
  }

  log("EVENTS", `Extracted ${result.length} CLEAN events`);
  return result;
}
