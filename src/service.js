const express = require("express");
const { authRouter, setAuthUser } = require("./routes/authRouter.js");
const orderRouter = require("./routes/orderRouter.js");
const franchiseRouter = require("./routes/franchiseRouter.js");
const userRouter = require("./routes/userRouter.js");
const version = require("./version.json");
const config = require("./config.js");
const metrics = require("./metrics");
const logger = require("./logger");

const app = express();
app.use(express.json());
app.use(setAuthUser);
app.use(metrics.requestTracker);
app.use(logger.httpLogger);

const configuredAllowlist = Array.isArray(config?.cors?.allowlist)
  ? config.cors.allowlist
  : (process.env.CORS_ALLOWLIST || "http://localhost:3000")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean);
const allowedOrigins = new Set(configuredAllowlist);
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigins.has(origin)) {
      return res.sendStatus(403);
    }
    return res.sendStatus(204);
  }

  next();
});

const apiRouter = express.Router();
app.use("/api", apiRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/user", userRouter);
apiRouter.use("/order", orderRouter);
apiRouter.use("/franchise", franchiseRouter);

apiRouter.use("/docs", (req, res) => {
  res.json({
    version: version.version,
    endpoints: [
      ...authRouter.docs,
      ...userRouter.docs,
      ...orderRouter.docs,
      ...franchiseRouter.docs,
    ],
    //config: { factory: config.factory.url, db: config.db.connection.host },
  });
});

app.get("/", (req, res) => {
  res.json({
    message: "welcome to JWT Pizza",
    version: version.version,
  });
});

app.use("*", (req, res) => {
  res.status(404).json({
    message: "unknown endpoint",
  });
});

// Default error handler for all exceptions and errors.
app.use((err, req, res, next) => {
  logger.logUnhandledException(err, "express");
  const statusCode = err.statusCode ?? 500;
  const isProduction = process.env.NODE_ENV === "production";
  const responseBody = {
    message:
      isProduction && statusCode >= 500 ? "Internal server error" : err.message,
  };

  res.status(statusCode).json(responseBody);
  next();
});

module.exports = app;
