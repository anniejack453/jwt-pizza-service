const request = require("supertest");
const app = require("../service");

const { initializeTestDatabase } = require("../database/testSetup.js");
const { DB } = require("../database/database.js");

const testDbName = `pizza_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
let testUserAuthToken;

beforeAll(async () => {
  // Set the test database for this test run
  process.env.TEST_DB_NAME = testDbName;
  await initializeTestDatabase(testDbName);
  testUser.email = Math.random().toString(36).substring(2, 12) + "@test.com";
  const registerRes = await request(app).post("/api/auth").send(testUser);
  testUserAuthToken = registerRes.body.token;
  expectValidJwt(testUserAuthToken);
});

afterAll(async () => {
  // Drop the test database after all tests
  const connection = await DB.getConnection();
  try {
    await connection.query(`DROP DATABASE IF EXISTS ${testDbName}`);
  } finally {
    connection.end();
  }
});

describe("get authenticated user", () => {
  test("requires authentication", async () => {
    const res = await request(app).get("/api/user/me");

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });

  test("returns authenticated user info", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${testUserAuthToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("id");
    expect(res.body).toHaveProperty("name");
    expect(res.body).toHaveProperty("email");
    expect(res.body).toHaveProperty("roles");
    expect(Array.isArray(res.body.roles)).toBe(true);
  });

  test("returns correct user data", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${testUserAuthToken}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe(testUser.name);
    expect(res.body.email).toBe(testUser.email);
  });

  test("cannot use invalid token", async () => {
    const res = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer invalidtoken123`);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });
});

describe("update user", () => {
  let userId;
  let userToken;
  let otherUserId;
  let otherUserToken;
  let adminToken;

  beforeAll(async () => {
    // Get current test user info
    const meRes = await request(app)
      .get("/api/user/me")
      .set("Authorization", `Bearer ${testUserAuthToken}`);
    userId = meRes.body.id;
    userToken = testUserAuthToken;

    // Create another user
    const otherEmail = `${Math.random().toString(36).substring(2, 12)}@test.com`;
    const otherRes = await request(app)
      .post("/api/auth")
      .send({ name: "Other User", email: otherEmail, password: "pass" });
    otherUserId = otherRes.body.user.id;
    otherUserToken = otherRes.body.token;

    // Get admin token
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    adminToken = adminLoginRes.body.token;
  });

  test("user can update their own info", async () => {
    const updates = {
      name: "Updated Name",
      email: testUser.email,
      password: "newpass",
    };

    const res = await request(app)
      .put(`/api/user/${userId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .send(updates);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("user");
    expect(res.body).toHaveProperty("token");
    expect(res.body.user.name).toBe(updates.name);
    expect(res.body.user.email).toBe(updates.email);
    expectValidJwt(res.body.token);
  });

  test("user cannot update another user's info", async () => {
    const updates = {
      name: "Hacker",
      email: "hacker@test.com",
      password: "hacked",
    };

    const res = await request(app)
      .put(`/api/user/${otherUserId}`)
      .set("Authorization", `Bearer ${userToken}`)
      .send(updates);

    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unauthorized");
  });

  test("admin can update any user's info", async () => {
    const updates = {
      name: "Admin Updated",
      email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
      password: "adminpass",
    };

    const res = await request(app)
      .put(`/api/user/${otherUserId}`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(updates);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("user");
    expect(res.body).toHaveProperty("token");
    expect(res.body.user.name).toBe(updates.name);
    expectValidJwt(res.body.token);
  });

  test("requires authentication", async () => {
    const updates = {
      name: "No Auth",
      email: "noauth@test.com",
      password: "pass",
    };

    const res = await request(app).put(`/api/user/${userId}`).send(updates);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });

  test("cannot use invalid token", async () => {
    const updates = {
      name: "Invalid Token",
      email: "invalid@test.com",
      password: "pass",
    };

    const res = await request(app)
      .put(`/api/user/${userId}`)
      .set("Authorization", `Bearer invalidtoken123`)
      .send(updates);

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
