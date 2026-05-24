interface Env {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  API_ORIGIN?: string;
}

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: "server_misconfigured", message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}

function normalizeOrigin(origin: string | undefined): string {
  return origin?.trim().replace(/\/$/, "") ?? "";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      const apiOrigin = normalizeOrigin(env.API_ORIGIN);
      if (!apiOrigin) {
        return jsonError("API_ORIGIN is not configured for the web worker.", 500);
      }

      const upstreamUrl = new URL(`${url.pathname}${url.search}`, `${apiOrigin}/`);
      return fetch(new Request(upstreamUrl.toString(), request));
    }

    return env.ASSETS.fetch(request);
  }
};
