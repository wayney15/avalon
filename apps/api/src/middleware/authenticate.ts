import type { MiddlewareHandler } from "hono";
import type { AppVariables, Env } from "../context";
import { verifyJwt } from "../jwt";

function unauthorized(message: string): Response {
  return Response.json({ error: "unauthorized", message }, { status: 401 });
}

export const authenticate: MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> = async (c, next) => {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return unauthorized("A bearer token is required.");
  }

  const token = authorization.slice("Bearer ".length).trim();
  if (!token) {
    return unauthorized("A bearer token is required.");
  }

  if (!c.env.JWT_SECRET) {
    return Response.json(
      { error: "server_misconfigured", message: "JWT signing is not configured." },
      { status: 500 }
    );
  }

  const claims = await verifyJwt(token, {
    issuer: c.env.JWT_ISSUER,
    secret: c.env.JWT_SECRET
  });

  if (!claims) {
    return unauthorized("The token is invalid or expired.");
  }

  const user = await c.env.DB
    .prepare("SELECT id, username, display_name AS displayName FROM users WHERE id = ?")
    .bind(claims.sub)
    .first<{ id: string; username: string; displayName: string }>();

  if (!user) {
    return unauthorized("The user no longer exists.");
  }

  c.set("authClaims", claims);
  c.set("authUser", user);

  await next();
};
