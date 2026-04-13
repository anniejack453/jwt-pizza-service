const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const config = require("../config.js");
const metrics = require("../metrics.js");
const { asyncHandler } = require("../endpointHelper.js");
const { DB, Role } = require("../database/database.js");

const authRouter = express.Router();
const authAttemptState = new Map();
const authRateLimitConfig = {
  maxFailedAttempts: config.auth?.maxFailedAttempts || 5,
  attemptWindowMs: config.auth?.attemptWindowMs || 15 * 60 * 1000,
  lockoutMs: config.auth?.lockoutMs || 15 * 60 * 1000,
};

let nowProvider = () => Date.now();

authRouter.docs = [
  {
    method: "POST",
    path: "/api/auth",
    description: "Register a new user",
    example: `curl -X POST localhost:3000/api/auth -d '{"name":"pizza diner", "email":"d@jwt.com", "password":"diner"}' -H 'Content-Type: application/json'`,
    response: {
      user: {
        id: 2,
        name: "pizza diner",
        email: "d@jwt.com",
        roles: [{ role: "diner" }],
      },
      token: "tttttt",
    },
  },
  {
    method: "PUT",
    path: "/api/auth",
    description: "Login existing user",
    example: `curl -X PUT localhost:3000/api/auth -d '{"email":"a@jwt.com", "password":"admin"}' -H 'Content-Type: application/json'`,
    response: {
      user: {
        id: 1,
        name: "常用名字",
        email: "a@jwt.com",
        roles: [{ role: "admin" }],
      },
      token: "tttttt",
    },
  },
  {
    method: "DELETE",
    path: "/api/auth",
    requiresAuth: true,
    description: "Logout a user",
    example: `curl -X DELETE localhost:3000/api/auth -H 'Authorization: Bearer tttttt'`,
    response: { message: "logout successful" },
  },
];

async function setAuthUser(req, res, next) {
  const token = readAuthToken(req);
  if (token) {
    try {
      if (await DB.isLoggedIn(token)) {
        // Check the database to make sure the token is valid.
        req.user = jwt.verify(token, config.jwtSecret);
        req.user.isRole = (role) =>
          !!req.user.roles.find((r) => r.role === role);
      }
    } catch {
      req.user = null;
    }
  }
  next();
}

// Authenticate token
authRouter.authenticateToken = (req, res, next) => {
  if (!req.user) {
    return res.status(401).send({ message: "unauthorized" });
  }
  next();
};

// register
authRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res
        .status(400)
        .json({ message: "name, email, and password are required" });
    }

    // Check if user already exists
    try {
      await DB.getUser(email);
      return res.status(409).json({ message: "Email already in use" });
    } catch {
      // User doesn't exist, continue with registration
    }

    const user = await DB.addUser({
      name,
      email,
      password,
      roles: [{ role: Role.Diner }],
    });
    const auth = await setAuth(user);
    res.json({ user: user, token: auth });
  }),
);

// login
authRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const throttleKey = getThrottleKey(email, req.ip);
    const lockExpiresAt = getLockExpiration(throttleKey);

    if (lockExpiresAt && lockExpiresAt > Date.now()) {
      metrics.recordAuthAttempt(false);
      return res
        .status(429)
        .json({ message: "Too many failed login attempts. Try again later." });
    }

    if (!email || !password) {
      if (!email) {
        metrics.recordAuthAttempt(false);
        return res.status(400).json({ message: "Email is required" });
      }
      if (!password) {
        metrics.recordAuthAttempt(false);
        return res.status(400).json({ message: "Password is required" });
      }
    }

    const attemptKey = getAuthAttemptKey(req, email);
    const now = nowProvider();
    const lockoutRemainingMs = getLockoutRemainingMs(attemptKey, now);
    if (lockoutRemainingMs > 0) {
      const retryAfterSeconds = Math.ceil(lockoutRemainingMs / 1000);
      res.set("Retry-After", String(retryAfterSeconds));
      return res.status(429).json({
        message: "Too many authentication attempts. Try again later.",
        retryAfterSeconds,
      });
    }

    try {
      const user = await DB.getUser(email, password);
      clearFailedAttempt(attemptKey);
      const auth = await setAuth(user);
      failedLoginAttempts.delete(throttleKey);
      metrics.recordAuthAttempt(true);
      res.json({ user: user, token: auth });
    } catch {
      const lockoutApplied = recordFailedAttempt(attemptKey, nowProvider());
      metrics.recordAuthAttempt(false);

      if (lockoutApplied) {
        const retryAfterSeconds = Math.ceil(
          authRateLimitConfig.lockoutMs / 1000,
        );
        res.set("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({
          message: "Too many authentication attempts. Try again later.",
          retryAfterSeconds,
        });
      }

      return res.status(401).json({ message: "Invalid email or password" });
    }
  }),
);

// logout
authRouter.delete(
  "/",
  authRouter.authenticateToken,
  asyncHandler(async (req, res) => {
    await clearAuth(req);
    res.json({ message: "logout successful" });
  }),
);

async function setAuth(user) {
  const token = jwt.sign(user, config.jwtSecret);
  await DB.loginUser(user.id, token);
  return token;
}

async function clearAuth(req) {
  const token = readAuthToken(req);
  if (token) {
    await DB.logoutUser(token);
  }
}

function readAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    return authHeader.split(" ")[1];
  }
  return null;
}

function getAuthAttemptKey(req, email) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const forwardedIp =
    typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0].trim()
      : undefined;
  const ip = forwardedIp || req.ip || req.socket?.remoteAddress || "unknown";
  return `${String(email).toLowerCase().trim()}|${ip}`;
}

function getLockoutRemainingMs(attemptKey, now) {
  const state = authAttemptState.get(attemptKey);
  if (!state) {
    return 0;
  }

  if (state.lockUntil && state.lockUntil > now) {
    return state.lockUntil - now;
  }

  if (now - state.windowStart >= authRateLimitConfig.attemptWindowMs) {
    authAttemptState.delete(attemptKey);
    return 0;
  }

  if (state.lockUntil && state.lockUntil <= now) {
    authAttemptState.delete(attemptKey);
  }

  return 0;
}

function recordFailedAttempt(attemptKey, now) {
  const existingState = authAttemptState.get(attemptKey);
  let state = existingState;

  if (
    !state ||
    now - state.windowStart >= authRateLimitConfig.attemptWindowMs
  ) {
    state = { count: 0, windowStart: now, lockUntil: 0 };
  }

  state.count += 1;

  if (state.count >= authRateLimitConfig.maxFailedAttempts) {
    state.lockUntil = now + authRateLimitConfig.lockoutMs;
  }

  authAttemptState.set(attemptKey, state);
  return state.lockUntil > now;
}

function clearFailedAttempt(attemptKey) {
  authAttemptState.delete(attemptKey);
}

function resetAuthAttemptLimiter() {
  authAttemptState.clear();
  nowProvider = () => Date.now();
}

function setNowProviderForTests(provider) {
  nowProvider = provider;
}

module.exports = {
  authRouter,
  setAuthUser,
  setAuth,
  resetAuthAttemptLimiter,
  setNowProviderForTests,
};
