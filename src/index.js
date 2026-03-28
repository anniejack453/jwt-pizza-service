const app = require("./service.js");
const logger = require("./logger");

process.on("uncaughtException", (error) => {
  logger.logUnhandledException(error, "uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  logger.logUnhandledException(error, "unhandledRejection");
});

const port = process.argv[2] || 3000;
app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
