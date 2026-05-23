export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

export interface AuthMeResponse {
  user: AuthUser;
}

export interface AuthErrorResponse {
  error: string;
  message: string;
}

export interface AuthenticatedUserClaims {
  sub: string;
  iss: string;
  iat: number;
  exp: number;
  username?: string;
  displayName?: string;
}

export interface SignupRequest {
  username: string;
  displayName: string;
  password: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}
