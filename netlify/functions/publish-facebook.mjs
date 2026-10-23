

const json = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export default async function handler(request) {
  if (request.method === "GET") {
    return json({
      service: "Marseille24h Facebook Publisher",
      status: "ready",
      publishing: "protected"
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const adminKey = process.env.MARSEILLE24H_ADMIN_KEY;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!adminKey || !pageId || !pageToken) {
    return json({ error: "Server configuration incomplete" }, 503);
  }

  const authorization = request.headers.get("Authorization");

  if (authorization !== `Bearer ${adminKey}`) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { message, approved, publish } = body;

  if (approved !== true || publish !== true) {
    return json({ error: "Explicit approval required" }, 403);
  }

  if (typeof message !== "string" ||
      !message.trim() ||
      message.length > 5000) {
    return json({ error: "Invalid message" }, 400);
  }

  try {
    const params = new URLSearchParams({
      message: message.trim(),
      published: "true"
    });

    const response = await fetch(
      `https://graph.facebook.com/v26.0/${encodeURIComponent(pageId)}/feed`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pageToken}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: params
      }
    );

    const result = await response.json();

    if (!response.ok) {
      return json({
        error: "Facebook rejected the request",
        code: result.error?.code ?? null
      }, 502);
    }

    return json({ success: true, postId: result.id });
  } catch {
    return json({ error: "Publishing failed" }, 502);
  }
}
