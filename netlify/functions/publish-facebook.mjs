
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
      authentication: "Supabase"
    });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!url || !key || !pageId || !pageToken) {
    return json({ error: "Configuration incomplete" }, 503);
  }

  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return json({ error: "Login required" }, 401);
  }

  const token = authorization.slice(7);

  const headers = {
    apikey: key,
    Authorization: `Bearer ${token}`
  };

  try {
    // Xác minh phiên đăng nhập với Supabase Auth
    const userResponse = await fetch(
      `${url}/auth/v1/user`,
      { headers }
    );

    if (!userResponse.ok) {
      return json({ error: "Invalid session" }, 401);
    }

    const user = await userResponse.json();

    if (!user.id) {
      return json({ error: "Invalid user" }, 401);
    }

    // Kiểm tra quyền Admin qua RLS
    const adminResponse = await fetch(
      `${url}/rest/v1/admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`,
      { headers }
    );

    if (!adminResponse.ok) {
      return json({ error: "Admin verification failed" }, 403);
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return json({ error: "Admin access required" }, 403);
    }

    const body = await request.json().catch(() => null);

    if (
      !body ||
      typeof body.articleId !== "string" ||
      body.confirmPublish !== true
    ) {
      return json({ error: "Invalid publish request" }, 400);
    }

    const articleId = body.articleId;

    // Lấy bài đã duyệt trực tiếp từ database
    const articleResponse = await fetch(
      `${url}/rest/v1/articles?id=eq.${encodeURIComponent(articleId)}&status=eq.approved&select=id,title,summary,content,source_name,source_url`,
      { headers }
    );

    if (!articleResponse.ok) {
      return json({ error: "Cannot load article" }, 502);
    }

    const articles = await articleResponse.json();

    if (!Array.isArray(articles) || articles.length !== 1) {
      return json({ error: "Article must be approved" }, 409);
    }

    const article = articles[0];

    const message = [
      article.title,
      article.summary,
      article.content,
      article.source_name
        ? `Nguồn: ${article.source_name}`
        : "",
      article.source_url || ""
    ].filter(Boolean).join("\n\n");

    if (message.length > 5000) {
      return json({ error: "Article is too long" }, 400);
    }

    // Đăng lên Facebook bằng Page Token phía máy chủ
    const params = new URLSearchParams({
      message,
      published: "true"
    });

    const facebookResponse = await fetch(
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

    const facebookResult = await facebookResponse.json();

    if (!facebookResponse.ok || !facebookResult.id) {
      return json({
        error: "Facebook publishing failed",
        code: facebookResult.error?.code || null
      }, 502);
    }

    // Cập nhật trạng thái bài viết
    const updateResponse = await fetch(
      `${url}/rest/v1/articles?id=eq.${encodeURIComponent(articleId)}&status=eq.approved`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: "published",
          published_at: new Date().toISOString()
        })
      }
    );

    if (!updateResponse.ok) {
      return json({
        error: "Published on Facebook, but database update failed",
        facebookPostId: facebookResult.id
      }, 502);
    }

    const updated = await updateResponse.json();

    return json({
      success: true,
      facebookPostId: facebookResult.id,
      databaseUpdated: Array.isArray(updated) && updated.length === 1
    });

  } catch (error) {
    return json({
      error: "Publishing request failed"
    }, 500);
  }
}
