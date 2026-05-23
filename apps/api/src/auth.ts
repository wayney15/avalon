export interface NormalizedSignupInput {
  username: string;
  displayName: string;
  password: string;
}

export interface NormalizedLoginInput {
  username: string;
  password: string;
}

const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/;
const MAX_DISPLAY_NAME_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export function validateSignupInput(input: unknown): { ok: true; value: NormalizedSignupInput } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const { username, displayName, password } = input as Record<string, unknown>;
  if (typeof username !== "string" || typeof displayName !== "string" || typeof password !== "string") {
    return { ok: false, message: "username, displayName, and password are required." };
  }

  const normalizedUsername = normalizeUsername(username);
  const normalizedDisplayName = displayName.trim();

  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return {
      ok: false,
      message: "Username must be 3 to 32 characters and contain only lowercase letters, numbers, or underscores."
    };
  }

  if (normalizedDisplayName.length === 0 || normalizedDisplayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, message: "Display name must be between 1 and 32 characters." };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: "Password must be at least 8 characters long." };
  }

  return {
    ok: true,
    value: {
      displayName: normalizedDisplayName,
      password,
      username: normalizedUsername
    }
  };
}

export function validateLoginInput(input: unknown): { ok: true; value: NormalizedLoginInput } | { ok: false; message: string } {
  if (typeof input !== "object" || input === null) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const { username, password } = input as Record<string, unknown>;
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, message: "username and password are required." };
  }

  const normalizedUsername = normalizeUsername(username);
  if (!USERNAME_PATTERN.test(normalizedUsername)) {
    return {
      ok: false,
      message: "Username must be 3 to 32 characters and contain only lowercase letters, numbers, or underscores."
    };
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, message: "Password must be at least 8 characters long." };
  }

  return {
    ok: true,
    value: {
      password,
      username: normalizedUsername
    }
  };
}

export function authError(error: string, message: string): { error: string; message: string } {
  return { error, message };
}
