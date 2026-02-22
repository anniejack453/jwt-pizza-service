const request = require("supertest");
const app = require("../service");

const { initializeTestDatabase } = require("../database/testSetup.js");
const { DB } = require("../database/database.js");

const testUser = { name: "pizza diner", email: "reg@test.com", password: "a" };
let testUserAuthToken;
let testDbName;

beforeAll(async () => {
  // Generate unique database name at runtime
  testDbName = `pizza_test_${Date.now()}_${Math.random().toString(36).substring(7)}`;
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

describe("list users", () => {
  let adminToken;
  let regularUserToken;

  beforeAll(async () => {
    // Get admin token
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    adminToken = adminLoginRes.body.token;

    // Create a regular user
    const [, userToken] = await registerUser(request(app));
    regularUserToken = userToken;
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/user");
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });

  test("rejects non-admin users", async () => {
    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${regularUserToken}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("unauthorized");
  });

  test("admin can list all users", async () => {
    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("users");
    expect(Array.isArray(res.body.users)).toBe(true);
    expect(res.body.users.length).toBeGreaterThan(0);
  });

  test("returns user with name, email, and roles", async () => {
    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users[0]).toHaveProperty("name");
    expect(res.body.users[0]).toHaveProperty("email");
    expect(res.body.users[0]).toHaveProperty("roles");
    expect(Array.isArray(res.body.users[0].roles)).toBe(true);
  });

  test("does not return password", async () => {
    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users[0]).not.toHaveProperty("password");
  });

  test("filters users by name", async () => {
    // Create a user with a unique name
    const uniqueName = `TestUser_${Math.random().toString(36).substring(2, 10)}`;
    await request(app)
      .post("/api/auth")
      .send({
        name: uniqueName,
        email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
        password: "pass",
      });

    // Filter by the unique name
    const res = await request(app)
      .get(`/api/user?name=${uniqueName}`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    expect(res.body.users[0].name).toBe(uniqueName);
  });

  test("filters users by partial name", async () => {
    // Create users with similar names
    const baseName = `FilterTest_${Math.random().toString(36).substring(2, 6)}`;
    await request(app)
      .post("/api/auth")
      .send({
        name: `${baseName}_Alpha`,
        email: `${Math.random().toString(36).substring(2, 12)}@test.com`,
        password: "pass",
      });

    // Filter using partial name with wildcard
    const res = await request(app)
      .get(`/api/user?name=${baseName}*`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeGreaterThan(0);
    expect(res.body.users.some((u) => u.name.includes(baseName))).toBe(true);
  });

  test("supports pagination with page and limit", async () => {
    // Get first page with limit of 2
    const res1 = await request(app)
      .get("/api/user?page=0&limit=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res1.status).toBe(200);
    expect(res1.body).toHaveProperty("users");
    expect(res1.body).toHaveProperty("page");
    expect(res1.body.page).toBe(0);
    expect(res1.body.users.length).toBeLessThanOrEqual(2);

    // Get second page
    const res2 = await request(app)
      .get("/api/user?page=1&limit=2")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res2.status).toBe(200);
    expect(res2.body.page).toBe(1);
  });

  test("indicates when more results are available", async () => {
    // Create several users
    for (let i = 0; i < 5; i++) {
      await request(app)
        .post("/api/auth")
        .send({
          name: `PaginationTest_${i}`,
          email: `pagination${i}_${Math.random().toString(36).substring(2, 12)}@test.com`,
          password: "pass",
        });
    }

    // Request with small limit
    const res = await request(app)
      .get("/api/user?page=0&limit=3")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("more");
    expect(typeof res.body.more).toBe("boolean");
  });

  test("uses default pagination values", async () => {
    const res = await request(app)
      .get("/api/user")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("users");
    expect(res.body).toHaveProperty("page");
    expect(Array.isArray(res.body.users)).toBe(true);
  });

  test("pagination works with name filtering", async () => {
    // Create users with a specific pattern
    const prefix = `PageFilter_${Math.random().toString(36).substring(2, 6)}`;
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/auth")
        .send({
          name: `${prefix}_User${i}`,
          email: `pagefilter${i}_${Math.random().toString(36).substring(2, 12)}@test.com`,
          password: "pass",
        });
    }

    // Filter and paginate
    const res = await request(app)
      .get(`/api/user?name=${prefix}*&page=0&limit=2`)
      .set("Authorization", `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.users.length).toBeLessThanOrEqual(2);
    expect(res.body.users.every((u) => u.name.includes(prefix))).toBe(true);
  });
});

async function registerUser(service) {
  const testUser = {
    name: "pizza diner",
    email: `${randomName()}@test.com`,
    password: "a",
  };
  const registerRes = await service.post("/api/auth").send(testUser);
  registerRes.body.user.password = testUser.password;

  return [registerRes.body.user, registerRes.body.token];
}

function randomName() {
  return Math.random().toString(36).substring(2, 12);
}

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
