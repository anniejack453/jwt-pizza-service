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

describe("get pizza menu", () => {
  test("returns menu without authentication", async () => {
    const res = await request(app).get("/api/order/menu");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });

  test("menu items have expected structure", async () => {
    const res = await request(app).get("/api/order/menu");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    if (res.body.length > 0) {
      const item = res.body[0];
      expect(item).toHaveProperty("id");
      expect(item).toHaveProperty("title");
      expect(item).toHaveProperty("description");
      expect(item).toHaveProperty("image");
      expect(item).toHaveProperty("price");
    }
  });
});

describe("add menu item", () => {
  let adminToken;

  beforeAll(async () => {
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    adminToken = adminLoginRes.body.token;
    expectValidJwt(adminToken);
  });

  test("admin can add a menu item", async () => {
    const menuItem = {
      title: `Special ${Math.random().toString(36).substring(7)}`,
      description: "Test item",
      image: "pizza9.png",
      price: 0.0001,
    };

    const addRes = await request(app)
      .put("/api/order/menu")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(menuItem);

    expect(addRes.status).toBe(200);
    expect(Array.isArray(addRes.body)).toBe(true);
    expect(addRes.body.length).toBeGreaterThan(0);
    const added = addRes.body.find((item) => item.title === menuItem.title);
    expect(added).toBeDefined();
    expect(added.description).toBe(menuItem.description);
    expect(added.image).toBe(menuItem.image);
    expect(added.price).toBe(menuItem.price);
  });

  test("cannot add a menu item without authentication", async () => {
    const menuItem = {
      title: "NoAuth Item",
      description: "No auth",
      image: "pizza9.png",
      price: 0.0002,
    };

    const addRes = await request(app).put("/api/order/menu").send(menuItem);

    expect(addRes.status).toBe(401);
    expect(addRes.body.message).toBe("unauthorized");
  });

  test("cannot add a menu item if not admin", async () => {
    const menuItem = {
      title: "NonAdmin Item",
      description: "Not admin",
      image: "pizza9.png",
      price: 0.0003,
    };

    const addRes = await request(app)
      .put("/api/order/menu")
      .set("Authorization", `Bearer ${testUserAuthToken}`)
      .send(menuItem);

    expect(addRes.status).toBe(403);
    expect(addRes.body.message).toBe("unable to add menu item");
  });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
