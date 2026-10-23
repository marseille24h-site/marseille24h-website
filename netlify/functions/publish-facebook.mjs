
const reply = (data, status = 200) =>
  Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" }
  });

export default async function handler(request) {
  if (request.method === "GET") {
    return reply({
      service: "Marseille24h Facebook Publisher",
      status: "ready",
      authentication: "Supabase",
      duplicateProtection: "enabled"
    });
  }

  if (request.method !== "POST") {
    return reply({ error: "Method not allowed" }, 405);
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  const pageId = process.env.FACEBOOK_PAGE_ID;
  const pageToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;

  if (!url || !key || !pageId || !pageToken) {
    return reply({ error: "Missing configuration" }, 503);
  }

  const authorization =
    request.headers.get("Authorization") || "";

  if (!authorization.startsWith("Bearer ")) {
    return reply({ error: "Login required" }, 401);
  }

  const token = authorization.slice(7);

  const headers = {
    apikey: key,
    Authorization: `Bearer ${token}`
  };

  try {
    // Xác minh người đăng nhập
    const userResponse = await fetch(`${url}/auth/v1/user`, {
      headers
    });

    if (!userResponse.ok) {
      return reply({ error: "Invalid session" }, 401);
    }

    const user = await userResponse.json();

    if (!user.id) {
      return reply({ error: "Invalid user" }, 401);
    }

    // Kiểm tra quyền quản trị
    const adminResponse = await fetch(
      `${url}/rest/v1/admins?user_id=eq.${user.id}&select=user_id`,
      { headers }
    );

    if (!adminResponse.ok) {
      return reply({ error: "Admin check failed" }, 403);
    }

    const admins = await adminResponse.json();

    if (!Array.isArray(admins) || admins.length !== 1) {
      return reply({ error: "Admin required" }, 403);
    }

    const body = await request.json().catch(() => null);

    if (
      !body ||
      typeof body.articleId !== "string" ||
      body.confirmPublish !== true ||
      !/^[0-9a-f-]{36}$/i.test(body.articleId)
    ) {
      return reply({ error: "Invalid request" }, 400);
    }

    const articleId = body.articleId;

    // Đọc bài đã được duyệt
    const articleResponse = await fetch(
      `${url}/rest/v1/articles?id=eq.${articleId}&status=eq.approved&facebook_post_id=is.null&select=*`,
      { headers }
    );

    if (!articleResponse.ok) {
      return reply({ error: "Cannot load article" }, 502);
    }

    const articles = await articleResponse.json();

    if (!Array.isArray(articles) || articles.length !== 1) {
      return reply({
        error: "Article not approved or already processed"
      }, 409);
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

    if (!message.trim() || message.length > 5000) {
      return reply({ error: "Invalid article content" }, 400);
    }

    // Khóa bài bằng thao tác nguyên tử trong PostgreSQL
    const claimResponse = await fetch(
      `${url}/rest/v1/rpc/claim_article_for_facebook`,
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          p_article_id: articleId
        })
      }
    );

    if (!claimResponse.ok) {
      return reply({ error: "Cannot lock article" }, 409);
    }

    const claimed = await claimResponse.json();

    if (claimed !== true) {
      return reply({
        error: "Article is already being published"
      }, 409);
    }

    // Từ đây KHÔNG tự động thử lại khi xảy ra lỗi.
    // Bài giữ trạng thái publishing nếu kết quả chưa rõ.
    let facebookResponse;

    try {
      facebookResponse = await fetch(
        `https://graph.facebook.com/v26.0/${encodeURIComponent(pageId)}/feed`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${pageToken}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            message,
            published: "true"
          })
        }
      );
    } catch {
      return reply({
        error: "Facebook result uncertain",
        action: "Check Facebook Page before retrying"
      }, 502);
    }

    const facebookResult =
      await facebookResponse.json().catch(() => ({}));

    if (!facebookResponse.ok || !facebookResult.id) {
      return reply({
        error: "Facebook did not confirm publication",
        action: "Check Page and publishing status manually",
        code: facebookResult.error?.code ?? null
      }, 502);
    }

    // Lưu Facebook Post ID và trạng thái
    const updateResponse = await fetch(
      `${url}/rest/v1/articles?id=eq.${articleId}&status=eq.publishing&facebook_post_id=is.null`,
      {
        method: "PATCH",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify({
          status: "published",
          facebook_post_id: facebookResult.id,
          published_at: new Date().toISOString()
        })
      }
    );

    if (!updateResponse.ok) {
      return reply({
        error: "Facebook published; database update failed",
        facebookPostId: facebookResult.id,
        action: "Do not publish again"
      }, 502);
    }

    const updated = await updateResponse.json();

    if (!Array.isArray(updated) || updated.length !== 1) {
      return reply({
        error: "Facebook published; database confirmation missing",
        facebookPostId: facebookResult.id,
        action: "Do not publish again"
      }, 502);
    }

    return reply({
      success: true,
      facebookPostId: facebookResult.id,
      databaseUpdated: true
    });

  } catch {
    return reply({
      error: "Request failed",
      action: "Check article status before retrying"
    }, 500);
  }
}
