const express = require("express");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const config = require("../config.js");
const metrics = require("../metrics.js");
const { asyncHandler } = require("../endpointHelper.js");
const { DB, Role } = require("../database/database.js");

const authRouter = express.Router();
const AUTH_RATE_LIMIT_WINDOW_MS =
  Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX) || 100;
const AUTH_FAILURE_WINDOW_MS =
  Number(process.env.AUTH_FAILURE_WINDOW_MS) || 15 * 60 * 1000;
const AUTH_MAX_FAILED_ATTEMPTS =
  Number(process.env.AUTH_MAX_FAILED_ATTEMPTS) || 5;
const AUTH_LOCKOUT_MS = Number(process.env.AUTH_LOCKOUT_MS) || 15 * 60 * 1000;
const failedLoginAttempts = new Map();

const authEndpointLimiter = rateLimit({
  windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many authentication requests. Try again later." },
});

authRouter.use(authEndpointLimiter);

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
    try {
      const user = await DB.getUser(email, password);
      const auth = await setAuth(user);
      failedLoginAttempts.delete(throttleKey);
      metrics.recordAuthAttempt(true);
      res.json({ user: user, token: auth });
    } catch {
      metrics.recordAuthAttempt(false);
      const shouldLock = recordFailedAttempt(throttleKey);
      if (shouldLock) {
        return res
          .status(429)
          .json({
            message: "Too many failed login attempts. Try again later.",
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

function getThrottleKey(email, ipAddress) {
  return `${(email || "").toLowerCase()}::${ipAddress || "unknown"}`;
}

function getLockExpiration(throttleKey) {
  pruneExpiredAttempts();
  return failedLoginAttempts.get(throttleKey)?.lockUntil ?? null;
}

function recordFailedAttempt(throttleKey) {
  const now = Date.now();
  const attemptData = failedLoginAttempts.get(throttleKey) || {
    attempts: [],
    lockUntil: null,
  };

  attemptData.attempts = attemptData.attempts.filter(
    (timestamp) => now - timestamp <= AUTH_FAILURE_WINDOW_MS,
  );
  attemptData.attempts.push(now);

  if (attemptData.attempts.length >= AUTH_MAX_FAILED_ATTEMPTS) {
    attemptData.lockUntil = now + AUTH_LOCKOUT_MS;
    attemptData.attempts = [];
  }

  failedLoginAttempts.set(throttleKey, attemptData);
  return !!attemptData.lockUntil && attemptData.lockUntil > now;
}

function pruneExpiredAttempts() {
  const now = Date.now();
  for (const [key, value] of failedLoginAttempts.entries()) {
    const hasRecentAttempts = value.attempts.some(
      (timestamp) => now - timestamp <= AUTH_FAILURE_WINDOW_MS,
    );
    const lockActive = value.lockUntil && value.lockUntil > now;
    if (!hasRecentAttempts && !lockActive) {
      failedLoginAttempts.delete(key);
    }
  }
}

module.exports = { authRouter, setAuthUser, setAuth };
