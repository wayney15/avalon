import type { AuthenticatedUserClaims, AuthUser } from "../../../packages/shared/src";

export interface Env {
  DB: D1Database;
  JWT_ISSUER: string;
  JWT_SECRET: string;
  ROOMS: DurableObjectNamespace;
}

export interface AppVariables {
  authClaims: AuthenticatedUserClaims;
  authUser: AuthUser;
}
