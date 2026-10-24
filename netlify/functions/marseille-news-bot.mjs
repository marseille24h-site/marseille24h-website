
const SCHEDULE = "0 */3 * * *";

const FEED =
  "https://news.google.com/rss/search?" +
  new URLSearchParams({
    q: "Marseille",
    hl: "fr",
    gl: "FR",
    ceid: "FR:fr"
  });

function decodeXml(value) {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function field(xml, tag) {
  const match = xml.match(
    new RegExp(
      `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`,
      "i"
    )
  );
  return match ? decodeXml(match[1].trim()) : "";
}

function parseFeed(xml) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

  return items.slice(0, 15).map(item => ({
    source_title: field(item, "title").slice(0, 500),
    source_url: field(item, "link"),
    source_name: field(item, "source") || "Google News",
    status: "new"
  })).filter(item => {
    try {
      const url = new URL(item.source_url);
      return item.source_title &&
        url.protocol === "https:";
    } catch {
      return false;
    }
  });
}

export default async function handler() {
  const url = process.env.SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secret) {
    console.error("News bot: missing Supabase configuration");
    return;
  }

  try {
    const response = await fetch(FEED, {
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`RSS HTTP ${response.status}`);
    }

    const xml = await response.text();
    const candidates = parseFeed(xml);

    if (!candidates.length) {
      console.log("News bot: no candidates found");
      return;
    }

    // Chỉ lưu tin mới, không tự đăng Facebook.
    const saved = await fetch(
      `${url}/rest/v1/news_candidates?on_conflict=source_url`,
      {
        method: "POST",
        headers: {
          apikey: secret,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal"
        },
        body: JSON.stringify(candidates)
      }
    );

    if (!saved.ok) {
      const details = await saved.text();
      console.error(
        "News bot: database error",
        saved.status,
        details.slice(0, 300)
      );
      return;
    }

    console.log(
      `Marseille24h: checked ${candidates.length} candidates`
    );

  } catch (error) {
    console.error("Marseille24h News Bot:", error.message);
  }
}

export const config = {
  schedule: SCHEDULE
};
