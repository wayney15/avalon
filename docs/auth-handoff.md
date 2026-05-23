# Auth Handoff

This document isolates the authentication workstream.

## Deliverables

- `apps/api/src/auth.ts`
- `apps/api/src/jwt.ts`
- `apps/api/src/passwords.ts`
- `apps/api/src/middleware/authenticate.ts`
- updates to `apps/api/src/index.ts`
- updates to `packages/shared/src/auth.ts`

## Endpoints

### `POST /api/auth/signup`

Request fields:
- `username`
- `displayName`
- `password`

Behavior:
- normalize username with lowercase + trim
- validate minimum username and password policy
- hash password
- create user row
- issue JWT
- return session and user

Error responses:
- `400` validation failure
- `409` duplicate username

### `POST /api/auth/login`

Request fields:
- `username`
- `password`

Behavior:
- normalize username
- verify password hash
- issue JWT
- return session and user

Error responses:
- `400` malformed payload
- `401` invalid credentials

### `GET /api/auth/me`

Behavior:
- require bearer token
- validate JWT
- load user from database
- return current user profile

Error responses:
- `401` missing token
- `401` invalid token
- `401` user no longer exists

## JWT Requirements

Required claims:
- `sub`
- `iss`
- `iat`
- `exp`

Optional claims:
- `username`
- `displayName`

Transport:
- `Authorization: Bearer <token>`

Recommended TTL:
- 7 days

## Password Hashing Requirements

- must work in Cloudflare Workers
- must not rely on Node-only crypto APIs
- plain text password must never be stored

## Protected Routes

Require auth immediately for:
- room creation
- room join
- room actions
- room history
- game replay
- WebSocket room/game connection

## Shared Contract Additions

Add:
- `AuthMeResponse`
- `AuthErrorResponse`
- `AuthenticatedUserClaims`

## Edge Cases

- username normalization must be identical at signup and login
- deleted users with old JWTs should fail authorization
- display names are not identity and may be duplicated

## Acceptance Checks

- successful signup returns JWT and user
- successful login returns JWT and user
- duplicate username fails with `409`
- bad password fails with `401`
- `GET /api/auth/me` returns current user
- protected route rejects invalid JWT
