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

describe("get orders", () => {
  let dinerToken;
  let dinerId;

  beforeAll(async () => {
    const dinerLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "diner@test.com", password: "diner123" });
    dinerToken = dinerLoginRes.body.token;
    dinerId = dinerLoginRes.body.user.id;
    expectValidJwt(dinerToken);
  });

  test("requires authentication", async () => {
    const res = await request(app).get("/api/order");

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });

  test("returns orders for authenticated diner", async () => {
    const res = await request(app)
      .get("/api/order")
      .set("Authorization", `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("dinerId", dinerId);
    expect(res.body).toHaveProperty("orders");
    expect(res.body).toHaveProperty("page");
    expect(Array.isArray(res.body.orders)).toBe(true);
    expect(res.body.orders.length).toBeGreaterThan(0);
  });

  test("orders have expected structure", async () => {
    const res = await request(app)
      .get("/api/order")
      .set("Authorization", `Bearer ${dinerToken}`);

    expect(res.status).toBe(200);
    if (res.body.orders.length > 0) {
      const order = res.body.orders[0];
      expect(order).toHaveProperty("id");
      expect(order).toHaveProperty("franchiseId");
      expect(order).toHaveProperty("storeId");
      expect(order).toHaveProperty("date");
      expect(order).toHaveProperty("items");
      expect(Array.isArray(order.items)).toBe(true);

      if (order.items.length > 0) {
        const item = order.items[0];
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("menuId");
        expect(item).toHaveProperty("description");
        expect(item).toHaveProperty("price");
      }
    }
  });
});

describe("create order", () => {
  let dinerToken;
  let franchiseId;
  let storeId;
  let menuId;
  let originalFetch;

  beforeAll(async () => {
    const dinerLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "diner@test.com", password: "diner123" });
    dinerToken = dinerLoginRes.body.token;
    expectValidJwt(dinerToken);

    const connection = await DB.getConnection();
    try {
      const [franchises] = await connection.query(
        `SELECT id FROM franchise LIMIT 1`,
      );
      const [stores] = await connection.query(
        `SELECT id, franchiseId FROM store LIMIT 1`,
      );
      const menu = await DB.getMenu();

      franchiseId = franchises[0].id;
      storeId = stores[0].id;
      menuId = menu[0].id;
    } finally {
      connection.end();
    }

    originalFetch = global.fetch;
  });

  afterEach(() => {
    if (global.fetch && global.fetch.mockRestore) {
      global.fetch.mockRestore();
    }
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  test("requires authentication", async () => {
    const res = await request(app)
      .post("/api/order")
      .send({
        franchiseId,
        storeId,
        items: [{ menuId, description: "Veggie", price: 0.0038 }],
      });

    expect(res.status).toBe(401);
    expect(res.body.message).toBe("unauthorized");
  });

  test("creates an order and returns factory response", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        reportUrl: "https://factory.example/report/123",
        jwt: "factory.jwt.token",
      }),
    });

    const res = await request(app)
      .post("/api/order")
      .set("Authorization", `Bearer ${dinerToken}`)
      .send({
        franchiseId,
        storeId,
        items: [{ menuId, description: "Veggie", price: 0.0038 }],
      });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("order");
    expect(res.body).toHaveProperty("followLinkToEndChaos");
    expect(res.body).toHaveProperty("jwt");
    expect(res.body.order).toHaveProperty("id");
    expect(res.body.order).toHaveProperty("items");
    expect(Array.isArray(res.body.order.items)).toBe(true);
  });

  test("returns 500 when factory fails", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({
        reportUrl: "https://factory.example/report/failed",
      }),
    });

    const res = await request(app)
      .post("/api/order")
      .set("Authorization", `Bearer ${dinerToken}`)
      .send({
        franchiseId,
        storeId,
        items: [{ menuId, description: "Veggie", price: 0.0038 }],
      });

    expect(res.status).toBe(500);
    expect(res.body.message).toBe("Failed to fulfill order at factory");
    expect(res.body.followLinkToEndChaos).toBeDefined();
  });
});

function expectValidJwt(potentialJwt) {
  expect(potentialJwt).toMatch(
    /^[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*\.[a-zA-Z0-9\-_]*$/,
  );
}
