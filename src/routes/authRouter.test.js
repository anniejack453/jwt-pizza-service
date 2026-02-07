const request = require("supertest");
const app = require("../service");

const { initializeTestDatabase } = require("../database/testSetup.js");

const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
let testUserAuthToken;

beforeAll(async () => {
  await initializeTestDatabase();
  testUser.email = Math.random().toString(36).substring(2, 12) + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

test("login", async () => {
  const loginRes = await request(app).put("/api/auth").send(testUser);
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);

  const expectedUser = { ...testUser, roles: [{ role: "diner" }] };
  delete expectedUser.password;
  expect(loginRes.body.user).toMatchObject(expectedUser);
});

test("invalid credentials", async () => {
  const invalidUser = { email: "t@jwt.com", password: "wrongpassword" };
  const loginRes = await request(app).put("/api/auth").send(invalidUser);
  expect(loginRes.status).toBe(401);
  expect(loginRes.body.message).toBe("Invalid email or password");
});

test("missing email", async () => {
  const loginRes = await request(app).put("/api/auth").send({ password: "a" });
  expect(loginRes.status).toBe(400);
  expect(loginRes.body.message).toBe("Email is required");
});

test("missing password", async () => {
  const loginRes = await request(app)
    .put("/api/auth")
    .send({ email: "reg@test.com" });
  expect(loginRes.status).toBe(400);
  expect(loginRes.body.message).toBe("Password is required");
});

test("user not found", async () => {
  const nonExistentUser = {
    email: "nonexistent@test.com",
    password: "password",
  };
  const loginRes = await request(app).put("/api/auth").send(nonExistentUser);
  expect(loginRes.status).toBe(401);
  expect(loginRes.body.message).toBe("Invalid email or password");
});

test("successful login with admin role", async () => {
  const adminUser = {
    name: "Admin User",
    email: "admin@test.com",
    password: "admin123",
  };
  const loginRes = await request(app)
    .put("/api/auth")
    .send({ email: "admin@test.com", password: "admin123" });
  expect(loginRes.status).toBe(200);
  expectValidJwt(loginRes.body.token);
  expect(loginRes.body.user.roles).toContainEqual({ role: "admin" });
});

test("expired token", async () => {
  const expiredToken = "expiredTokenExample"; // Mock an expired token
  const loginRes = await request(app)
    .put("/api/auth")
    .set("Authorization", `Bearer ${expiredToken}`);
  expect(loginRes.status).toBe(400);
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
