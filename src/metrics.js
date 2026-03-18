const os = require("os");
const config = require("./config");

const ACTIVE_USER_WINDOW_MS = 600000;

// Metrics stored in memory
const requests = {};

// Rolling 60-second windows for per-minute metrics
const requestTimestamps = [];
const methodRequestCounts = {
  GET: 0,
  PUT: 0,
  POST: 0,
  DELETE: 0,
};
const methodRequestTimestamps = {
  GET: [],
  PUT: [],
  POST: [],
  DELETE: [],
};
const activeUserLastSeen = {};
const authAttemptTimestamps = {
  success: [],
  failed: [],
};

// Latency tracking
let endpointLatencies = {};
let pizzaCreationLatencies = [];
const pizzaSoldEvents = [];
const pizzaCreationFailureTimestamps = [];
const pizzaRevenueEvents = [];

// Middleware to track requests
function requestTracker(req, res, next) {
  const endpoint = `[${req.method}] ${req.path}`;
  const startTime = Date.now();
  requests[endpoint] = (requests[endpoint] || 0) + 1;

  const now = startTime;
  requestTimestamps.push(now);

  if (methodRequestCounts[req.method] !== undefined) {
    methodRequestCounts[req.method]++;
    methodRequestTimestamps[req.method].push(now);
  }

  if (req.user?.id) {
    activeUserLastSeen[String(req.user.id)] = now;
  }

  // Track response time
  const originalJson = res.json;
  const originalSend = res.send;

  const finishRequest = () => {
    const latency = Date.now() - startTime;

    if (!endpointLatencies[endpoint]) {
      endpointLatencies[endpoint] = [];
    }
    endpointLatencies[endpoint].push(latency);
  };

  res.json = function (data) {
    finishRequest();
    return originalJson.call(this, data);
  };

  res.send = function (data) {
    finishRequest();
    return originalSend.call(this, data);
  };

  next();
}

function pruneWindow() {
  const cutoff = Date.now() - 60000;

  while (requestTimestamps.length && requestTimestamps[0] < cutoff) {
    requestTimestamps.shift();
  }

  Object.keys(methodRequestTimestamps).forEach((method) => {
    const timestamps = methodRequestTimestamps[method];
    while (timestamps.length && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  });

  Object.keys(authAttemptTimestamps).forEach((result) => {
    const timestamps = authAttemptTimestamps[result];
    while (timestamps.length && timestamps[0] < cutoff) {
      timestamps.shift();
    }
  });

  while (
    pizzaCreationFailureTimestamps.length &&
    pizzaCreationFailureTimestamps[0] < cutoff
  ) {
    pizzaCreationFailureTimestamps.shift();
  }

  while (pizzaSoldEvents.length && pizzaSoldEvents[0].timestamp < cutoff) {
    pizzaSoldEvents.shift();
  }

  while (
    pizzaRevenueEvents.length &&
    pizzaRevenueEvents[0].timestamp < cutoff
  ) {
    pizzaRevenueEvents.shift();
  }
}

function recordAuthAttempt(isSuccess) {
  const resultKey = isSuccess ? "success" : "failed";
  authAttemptTimestamps[resultKey].push(Date.now());
}

function pruneActiveUsers() {
  const cutoff = Date.now() - ACTIVE_USER_WINDOW_MS;
  Object.keys(activeUserLastSeen).forEach((userId) => {
    if (activeUserLastSeen[userId] < cutoff) {
      delete activeUserLastSeen[userId];
    }
  });
}

// This will periodically send metrics to Grafana
function flushMetrics() {
  pruneWindow();
  pruneActiveUsers();

  const totalTrackedRequestsPerMinute =
    methodRequestTimestamps.GET.length +
    methodRequestTimestamps.PUT.length +
    methodRequestTimestamps.POST.length +
    methodRequestTimestamps.DELETE.length;

  const metrics = [];
  Object.keys(requests).forEach((endpointKey) => {
    const { method, path } = parseEndpointKey(endpointKey);
    metrics.push(
      createMetric("requests", requests[endpointKey], "1", "sum", "asInt", {
        endpoint: path,
        method,
      }),
    );
  });

  metrics.push(
    createMetric(
      "requestsPerMinute",
      totalTrackedRequestsPerMinute,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "getRequestsPerMinute",
      methodRequestTimestamps.GET.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "putRequestsPerMinute",
      methodRequestTimestamps.PUT.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "postRequestsPerMinute",
      methodRequestTimestamps.POST.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "deleteRequestsPerMinute",
      methodRequestTimestamps.DELETE.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "successfulAuthAttemptsPerMinute",
      authAttemptTimestamps.success.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "failedAuthAttemptsPerMinute",
      authAttemptTimestamps.failed.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "activeUsers",
      Object.keys(activeUserLastSeen).length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "cpuUsage",
      getCpuUsagePercentage(),
      "%",
      "gauge",
      "asDouble",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "memoryUsage",
      getMemoryUsagePercentage(),
      "%",
      "gauge",
      "asDouble",
      {},
    ),
  );

  const pizzasSoldPerMinute = pizzaSoldEvents.reduce(
    (total, event) => total + event.count,
    0,
  );
  const pizzaRevenuePerMinute = pizzaRevenueEvents.reduce(
    (total, event) => total + event.revenue,
    0,
  );

  metrics.push(
    createMetric(
      "pizzasSoldPerMinute",
      pizzasSoldPerMinute,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "pizzaCreationFailuresPerMinute",
      pizzaCreationFailureTimestamps.length,
      "1",
      "gauge",
      "asInt",
      {},
    ),
  );

  metrics.push(
    createMetric(
      "pizzaRevenuePerMinute",
      Number(pizzaRevenuePerMinute.toFixed(4)),
      "USD",
      "gauge",
      "asDouble",
      {},
    ),
  );

  // Calculate endpoint latency metrics
  Object.keys(endpointLatencies).forEach((endpoint) => {
    const latencies = endpointLatencies[endpoint];
    if (latencies.length > 0) {
      const avg = latencies.reduce((a, b) => a + b) / latencies.length;
      const method = endpoint.match(/^\[(.+)]/)[1];
      const path = endpoint.split("] ")[1];

      metrics.push(
        createMetric("endpointLatency", avg, "ms", "gauge", "asDouble", {
          endpoint: path,
          method: method,
          percentile: "mean",
        }),
      );
    }
  });
  endpointLatencies = {};

  // Emit one latency metric per pizza creation request
  pizzaCreationLatencies.forEach((entry) => {
    metrics.push(
      createMetric(
        "pizzaCreationLatency",
        entry.latency,
        "ms",
        "gauge",
        "asDouble",
        {
          status: entry.success ? "success" : "failed",
        },
      ),
    );
  });
  pizzaCreationLatencies.length = 0;

  sendMetricToGrafana(metrics);
}

if (process.env.NODE_ENV !== "test") {
  const metricsInterval = setInterval(flushMetrics, 10000);
  if (typeof metricsInterval.unref === "function") {
    metricsInterval.unref();
  }
}

function parseEndpointKey(endpointKey) {
  const match = endpointKey.match(/^\[(.+)]\s(.+)$/);
  if (!match) {
    return { method: "UNKNOWN", path: endpointKey };
  }

  return {
    method: match[1],
    path: match[2],
  };
}

function createMetric(
  metricName,
  metricValue,
  metricUnit,
  metricType,
  valueType,
  attributes,
) {
  attributes = { ...attributes, source: config.metrics.source };

  const metric = {
    name: metricName,
    unit: metricUnit,
    [metricType]: {
      dataPoints: [
        {
          [valueType]: metricValue,
          timeUnixNano: Date.now() * 1000000,
          attributes: [],
        },
      ],
    },
  };

  Object.keys(attributes).forEach((key) => {
    metric[metricType].dataPoints[0].attributes.push({
      key: key,
      value: { stringValue: attributes[key] },
    });
  });

  if (metricType === "sum") {
    metric[metricType].aggregationTemporality =
      "AGGREGATION_TEMPORALITY_CUMULATIVE";
    metric[metricType].isMonotonic = true;
  }

  return metric;
}

function sendMetricToGrafana(metrics) {
  const body = {
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics,
          },
        ],
      },
    ],
  };

  fetch(`${config.metrics.endpointUrl}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${config.metrics.accountId}:${config.metrics.apiKey}`,
      "Content-Type": "application/json",
    },
  })
    .then(async (response) => {
      await response.text();
      if (!response.ok) {
        throw new Error(`HTTP status: ${response.status}`);
      }
    })
    .catch((error) => {
      console.error("Error pushing metrics:", error);
    });
}

function getCpuUsagePercentage() {
  const cpuUsage = os.loadavg()[0] / os.cpus().length;
  return cpuUsage.toFixed(2) * 100;
}

function getMemoryUsagePercentage() {
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = (usedMemory / totalMemory) * 100;
  return Number(memoryUsage.toFixed(2));
}

function pizzaPurchase(status, latencyMs, revenue = 0, pizzaCount = 0) {
  const normalizedStatus = String(status || "").toLowerCase();
  const success = normalizedStatus === "success" || status === true;
  const now = Date.now();

  if (typeof latencyMs === "number" && Number.isFinite(latencyMs)) {
    pizzaCreationLatencies.push({
      latency: latencyMs,
      timestamp: now,
      success,
    });
  }

  if (success) {
    if (pizzaCount > 0) {
      pizzaSoldEvents.push({ timestamp: now, count: pizzaCount });
    }
    if (revenue > 0) {
      pizzaRevenueEvents.push({ timestamp: now, revenue });
    }
  } else {
    pizzaCreationFailureTimestamps.push(now);
  }
}

module.exports = {
  requestTracker,
  recordAuthAttempt,
  pizzaPurchase,
  getCpuUsagePercentage,
  getMemoryUsagePercentage,
};
