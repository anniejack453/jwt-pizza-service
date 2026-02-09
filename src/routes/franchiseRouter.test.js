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

describe("create franchise", () => {
  test("successful franchise creation by admin", async () => {
    // Get admin token
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    const adminToken = adminLoginRes.body.token;

    const franchiseData = {
      name: `New Franchise ${Math.random().toString(36).substring(7)}`,
      admins: [{ email: "franchisee@test.com" }],
    };

    const createRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(franchiseData);

    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe(franchiseData.name);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.admins).toHaveLength(1);
  });

  test("cannot create franchise without authentication", async () => {
    const franchiseData = {
      name: "New Franchise",
      admins: [{ email: "franchisee@test.com" }],
    };

    const createRes = await request(app)
      .post("/api/franchise")
      .send(franchiseData);

    expect(createRes.status).toBe(401);
    expect(createRes.body.message).toBe("unauthorized");
  });

  test("cannot create franchise if not admin", async () => {
    // Get diner token (non-admin user)
    const dinerLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "diner@test.com", password: "diner123" });
    const dinerToken = dinerLoginRes.body.token;

    const franchiseData = {
      name: "New Franchise",
      admins: [{ email: "franchisee@test.com" }],
    };

    const createRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer ${dinerToken}`)
      .send(franchiseData);

    expect(createRes.status).toBe(403);
    expect(createRes.body.message).toBe("unable to create a franchise");
  });

  test("cannot create franchise with invalid token", async () => {
    const franchiseData = {
      name: "New Franchise",
      admins: [{ email: "franchisee@test.com" }],
    };

    const createRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer invalidtoken123`)
      .send(franchiseData);

    expect(createRes.status).toBe(401);
    expect(createRes.body.message).toBe("unauthorized");
  });

  test("cannot create franchise with non-existent admin email", async () => {
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    const adminToken = adminLoginRes.body.token;

    const franchiseData = {
      name: "New Franchise",
      admins: [{ email: "nonexistent@test.com" }],
    };

    const createRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(franchiseData);

    expect(createRes.status).toBe(404);
  });
});

describe("list user franchises", () => {
  test("user can list their own franchises", async () => {
    // Get franchisee token and their ID
    const franchiseeLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "franchisee@test.com", password: "franchisee123" });
    const franchiseeToken = franchiseeLoginRes.body.token;
    const franchiseeId = franchiseeLoginRes.body.user.id;

    const listRes = await request(app)
      .get(`/api/franchise/${franchiseeId}`)
      .set("Authorization", `Bearer ${franchiseeToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
    // Franchisee should have at least the test franchise
    expect(listRes.body.length).toBeGreaterThan(0);
  });

  test("admin can list any user's franchises", async () => {
    // Get admin token
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    const adminToken = adminLoginRes.body.token;

    // Get diner ID
    const dinerLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "diner@test.com", password: "diner123" });
    const dinerId = dinerLoginRes.body.user.id;

    const listRes = await request(app)
      .get(`/api/franchise/${dinerId}`)
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body)).toBe(true);
  });

  test("user cannot list another user's franchises", async () => {
    // Get diner token
    const dinerLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "diner@test.com", password: "diner123" });
    const dinerToken = dinerLoginRes.body.token;

    // Get franchisee ID
    const franchiseeLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "franchisee@test.com", password: "franchisee123" });
    const franchiseeId = franchiseeLoginRes.body.user.id;

    const listRes = await request(app)
      .get(`/api/franchise/${franchiseeId}`)
      .set("Authorization", `Bearer ${dinerToken}`);

    expect(listRes.status).toBe(200);
    // Should return empty array since authorization check prevents access
    expect(listRes.body).toEqual([]);
  });

  test("cannot list franchises without authentication", async () => {
    const listRes = await request(app).get("/api/franchise/1");

    expect(listRes.status).toBe(401);
    expect(listRes.body.message).toBe("unauthorized");
  });

  test("cannot list franchises with invalid token", async () => {
    const listRes = await request(app)
      .get("/api/franchise/1")
      .set("Authorization", `Bearer invalidtoken123`);

    expect(listRes.status).toBe(401);
    expect(listRes.body.message).toBe("unauthorized");
  });
});

describe("list all franchises", () => {
  test("list all franchises", async () => {
    const listRes = await request(app).get("/api/franchise");

    expect(listRes.status).toBe(200);
    expect(listRes.body).toHaveProperty("franchises");
    expect(listRes.body).toHaveProperty("more");
    expect(Array.isArray(listRes.body.franchises)).toBe(true);
    expect(typeof listRes.body.more).toBe("boolean");
    // Should have at least the test franchise
    expect(listRes.body.franchises.length).toBeGreaterThan(0);
  });

  test("list franchises with pagination", async () => {
    const listRes = await request(app)
      .get("/api/franchise")
      .query({ page: 0, limit: 1 });

    expect(listRes.status).toBe(200);
    expect(listRes.body.franchises.length).toBeLessThanOrEqual(1);
    expect(listRes.body).toHaveProperty("more");
  });

  test("list franchises with name filter", async () => {
    const listRes = await request(app)
      .get("/api/franchise")
      .query({ name: "Test" });

    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.franchises)).toBe(true);
    // All returned franchises should match the filter
    listRes.body.franchises.forEach((franchise) => {
      expect(franchise.name.toLowerCase()).toContain("test");
    });
  });

  test("list franchises with non-matching name filter", async () => {
    const listRes = await request(app)
      .get("/api/franchise")
      .query({ name: "NonexistentFranchise12345" });

    expect(listRes.status).toBe(200);
    expect(listRes.body.franchises.length).toBe(0);
    expect(listRes.body.more).toBe(false);
  });

  test("franchise has correct structure", async () => {
    const listRes = await request(app).get("/api/franchise");

    expect(listRes.status).toBe(200);
    if (listRes.body.franchises.length > 0) {
      const franchise = listRes.body.franchises[0];
      expect(franchise).toHaveProperty("id");
      expect(franchise).toHaveProperty("name");
      expect(franchise).toHaveProperty("stores");
      expect(Array.isArray(franchise.stores)).toBe(true);
    }
  });

  test("franchise has correct structure for admin", async () => {
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    const adminToken = adminLoginRes.body.token;

    const listRes = await request(app)
      .get("/api/franchise")
      .set("Authorization", `Bearer ${adminToken}`);

    expect(listRes.status).toBe(200);
    if (listRes.body.franchises.length > 0) {
      const franchise = listRes.body.franchises[0];
      expect(franchise).toHaveProperty("id");
      expect(franchise).toHaveProperty("name");
      expect(franchise).toHaveProperty("admins");
      expect(franchise).toHaveProperty("stores");
      expect(Array.isArray(franchise.admins)).toBe(true);
      expect(Array.isArray(franchise.stores)).toBe(true);
    }
  });

  test("list franchises does not require authentication", async () => {
    const listRes = await request(app).get("/api/franchise");

    expect(listRes.status).toBe(200);
    // Should succeed even without a token
    expect(listRes.body).toHaveProperty("franchises");
  });
});

describe("create store", () => {
  let franchiseId;
  let franchiseeToken;
  let adminToken;

  beforeAll(async () => {
    // Get admin token
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    adminToken = adminLoginRes.body.token;

    // Get franchisee token
    const franchiseeLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "franchisee@test.com", password: "franchisee123" });
    franchiseeToken = franchiseeLoginRes.body.token;

    // Create a franchise for testing
    const franchiseRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: `Test Franchise ${Math.random().toString(36).substring(7)}`,
        admins: [{ email: "franchisee@test.com" }],
      });
    franchiseId = franchiseRes.body.id;
  });

  test("franchisee can create a store in their franchise", async () => {
    const storeData = {
      name: `Store ${Math.random().toString(36).substring(7)}`,
    };

    const createRes = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .set("Authorization", `Bearer ${franchiseeToken}`)
      .send(storeData);

    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe(storeData.name);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.totalRevenue).toBe(0);
  });

  test("admin can create a store in any franchise", async () => {
    const storeData = {
      name: `Store ${Math.random().toString(36).substring(7)}`,
    };

    const createRes = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(storeData);

    expect(createRes.status).toBe(200);
    expect(createRes.body.name).toBe(storeData.name);
    expect(createRes.body.id).toBeDefined();
    expect(createRes.body.totalRevenue).toBe(0);
  });

  test("cannot create store without authentication", async () => {
    const storeData = {
      name: "Store",
    };

    const createRes = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .send(storeData);

    expect(createRes.status).toBe(401);
    expect(createRes.body.message).toBe("unauthorized");
  });

  test("cannot create store if not franchise admin or system admin", async () => {
    // Use testUser (diner) who is not a franchise admin
    const storeData = {
      name: "Store",
    };

    const createRes = await request(app)
      .post(`/api/franchise/${franchiseId}/store`)
      .set("Authorization", `Bearer ${testUserAuthToken}`)
      .send(storeData);

    expect(createRes.status).toBe(403);
    expect(createRes.body.message).toBe("unable to create a store");
  });

  test("cannot create store for non-existent franchise", async () => {
    const storeData = {
      name: "Store",
    };

    const createRes = await request(app)
      .post(`/api/franchise/99999/store`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send(storeData);

    expect(createRes.status).toBe(403);
    expect(createRes.body.message).toBe("unable to create a store");
  });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
