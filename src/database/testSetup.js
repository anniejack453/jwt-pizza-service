const { DB, Role } = require("./database.js");
const request = require("supertest");
const app = require("../service.js");

/**
 * Initializes the test database with sample data
 * Creates: 1 admin, 1 diner, 1 franchisee, 1 franchise, 1 store, menu items, and an order
 */
async function initializeTestDatabase(dbName) {
  try {
    // Set the test database name in environment if provided
    if (dbName) {
      process.env.TEST_DB_NAME = dbName;
    }

    // Wait for DB to initialize
    await DB.initialized;

    let admin, diner, franchiseeUser;
    let usersExist = false;

    // Check if test database is already initialized
    try {
      admin = await DB.getUser("admin@test.com");
      diner = await DB.getUser("diner@test.com");
      franchiseeUser = await DB.getUser("franchisee@test.com");
      usersExist = true;

      console.log("Test users already exist, cleaning up accumulated data");
    } catch {
      // Users don't exist, proceed with full initialization
      console.log("Initializing test database from scratch");
    }

    // Clear existing data by deleting in correct order (respecting foreign keys)
    const connection = await DB.getConnection();
    try {
      await connection.query(`DELETE FROM orderItem`);
      await connection.query(`DELETE FROM dinerOrder`);
      await connection.query(`DELETE FROM store`);
      await connection.query(`DELETE FROM userRole`);
      await connection.query(`DELETE FROM auth`);
      await connection.query(`DELETE FROM franchise`);
      if (!usersExist) {
        await connection.query(`DELETE FROM user`);
      }
      await connection.query(`DELETE FROM menu`);
    } finally {
      connection.end();
    }

    if (!usersExist) {
      // Create admin user
      admin = await DB.addUser({
        name: "Admin User",
        email: "admin@test.com",
        password: "admin123",
        roles: [{ role: Role.Admin }],
      });
    } else {
      // Re-add base role for existing admin user
      const conn = await DB.getConnection();
      try {
        await conn.query(
          `INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)`,
          [admin.id, Role.Admin, 0],
        );
      } finally {
        conn.end();
      }
    }

    // Get admin token for API requests
    const adminLoginRes = await request(app)
      .put("/api/auth")
      .send({ email: "admin@test.com", password: "admin123" });
    const adminToken = adminLoginRes.body.token;

    // Add menu items
    const menuItems = [
      {
        title: "Veggie",
        description: "A garden of delight",
        image: "pizza1.png",
        price: 0.0038,
      },
      {
        title: "Pepperoni",
        description: "Spicy treat",
        image: "pizza2.png",
        price: 0.0042,
      },
      {
        title: "Margarita",
        description: "Essential classic",
        image: "pizza3.png",
        price: 0.0042,
      },
      {
        title: "Crusty",
        description: "A dry mouthed favorite",
        image: "pizza4.png",
        price: 0.0028,
      },
      {
        title: "Charred Leopard",
        description: "For those with a darker side",
        image: "pizza5.png",
        price: 0.0099,
      },
    ];

    for (const item of menuItems) {
      await request(app)
        .put("/api/order/menu")
        .set("Authorization", `Bearer ${adminToken}`)
        .send(item);
    }

    if (!usersExist) {
      // Create diner user
      diner = await DB.addUser({
        name: "Diner User",
        email: "diner@test.com",
        password: "diner123",
        roles: [{ role: Role.Diner }],
      });

      // Create franchisee user
      franchiseeUser = await DB.addUser({
        name: "Franchisee User",
        email: "franchisee@test.com",
        password: "franchisee123",
        roles: [{ role: Role.Diner }],
      });
    } else {
      // Re-add base diner role for existing users
      const conn = await DB.getConnection();
      try {
        await conn.query(
          `INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)`,
          [diner.id, Role.Diner, 0],
        );
        await conn.query(
          `INSERT INTO userRole (userId, role, objectId) VALUES (?, ?, ?)`,
          [franchiseeUser.id, Role.Diner, 0],
        );
      } finally {
        conn.end();
      }
    }

    // Create franchise with franchisee as admin
    // Use unique franchise name based on database name to avoid conflicts
    const franchiseName = dbName
      ? `Franchise_${dbName}`
      : `Test Franchise ${Date.now()}`;
    const franchiseRes = await request(app)
      .post("/api/franchise")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        name: franchiseName,
        admins: [{ email: "franchisee@test.com" }],
      });

    if (franchiseRes.status !== 200) {
      throw new Error(
        `Failed to create franchise: ${franchiseRes.status} ${JSON.stringify(franchiseRes.body)}`,
      );
    }

    const franchise = franchiseRes.body.franchise || franchiseRes.body;

    // Create store
    const storeRes = await request(app)
      .post(`/api/franchise/${franchise.id}/store`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({
        franchiseId: franchise.id,
        name: "Test Store",
      });

    if (storeRes.status !== 200) {
      throw new Error(
        `Failed to create store: ${storeRes.status} ${JSON.stringify(storeRes.body)}`,
      );
    }

    const store = storeRes.body.store || storeRes.body;

    // Get menu and create order
    const menu = await DB.getMenu();
    let order;
    if (menu && menu.length > 0) {
      const firstMenuItem = menu[0];

      // Create a pizza order for the diner
      order = await DB.addDinerOrder(diner, {
        franchiseId: franchise.id,
        storeId: store.id,
        items: [
          {
            menuId: firstMenuItem.id,
            description: firstMenuItem.title,
            price: firstMenuItem.price,
          },
        ],
      });
    }

    return {
      admin,
      diner,
      franchisee: franchiseeUser,
      franchise,
      store,
      order,
    };
  } catch (error) {
    console.error("Error initializing test database:", error);
    throw error;
  }
}

// Export the function
module.exports = { initializeTestDatabase };

// If run directly, execute initialization
if (require.main === module) {
  initializeTestDatabase()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
