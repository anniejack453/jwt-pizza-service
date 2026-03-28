const config = require("./config");
const loggingConfig = config.logging || config;

class Logger {
  httpLogger = (req, res, next) => {
    const send = res.send;
    res.send = (resBody) => {
      const logData = {
        authorized: !!req.headers.authorization,
        path: req.originalUrl,
        method: req.method,
        statusCode: res.statusCode,
        reqBody: req.body,
        resBody,
      };
      const level = this.statusToLogLevel(res.statusCode);
      this.log(level, "http", logData);
      res.send = send;
      return res.send(resBody);
    };
    next();
  };

  log(level, type, logData) {
    const labels = {
      component: loggingConfig.source,
      level: level,
      type: type,
    };
    const values = [this.nowString(), this.sanitize(logData)];
    const logEvent = { streams: [{ stream: labels, values: [values] }] };

    this.sendLogToGrafana(logEvent);
  }

  logUnhandledException(error, source = "unknown") {
    this.log("error", "exception", {
      source,
      name: error?.name,
      message: error?.message,
      stack: error?.stack,
    });
  }

  statusToLogLevel(statusCode) {
    if (statusCode >= 500) return "error";
    if (statusCode >= 400) return "warn";
    return "info";
  }

  nowString() {
    return (Math.floor(Date.now()) * 1000000).toString();
  }

  sanitize(logData) {
    const redacted = this.redactSensitiveData(logData);
    return JSON.stringify(redacted);
  }

  redactSensitiveData(value, keyName = "") {
    if (value === null || value === undefined) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactSensitiveData(item));
    }

    if (typeof value === "object") {
      const redactedObject = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        if (this.isSensitiveKey(key)) {
          redactedObject[key] = "*****";
        } else {
          redactedObject[key] = this.redactSensitiveData(nestedValue, key);
        }
      }
      return redactedObject;
    }

    if (typeof value === "string") {
      if (this.isSensitiveKey(keyName)) {
        return "*****";
      }

      let sanitizedString = value;
      sanitizedString = sanitizedString.replace(
        /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
        "Bearer *****",
      );
      sanitizedString = sanitizedString.replace(
        /(["']?(password|token|jwt|secret|api[-_]?key|authorization|email)["']?\s*[:=]\s*["'])[^"']*(["'])/gi,
        "$1*****$3",
      );
      return sanitizedString;
    }

    return value;
  }

  isSensitiveKey(key) {
    return /password|token|jwt|secret|api[-_]?key|authorization|email/i.test(
      key,
    );
  }

  sendLogToGrafana(event) {
    const body = JSON.stringify(event);
    fetch(`${loggingConfig.endpointUrl}`, {
      method: "post",
      body: body,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${loggingConfig.accountId}:${loggingConfig.apiKey}`,
      },
    })
      .then((res) => {
        if (!res.ok) console.log("Failed to send log to Grafana");
      })
      .catch(() => {
        console.log("Failed to send log to Grafana");
      });
  }
}
module.exports = new Logger();
